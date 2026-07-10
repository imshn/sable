import { randomUUID } from 'node:crypto'
import { io } from '../io.js'
import { store } from '../db.js'
import { online, known, groups } from '../state.js'
import { groupInfo, emitToMembers } from '../helpers.js'
import { notifyOffline } from '../notify.js'
import type { AppSocket, ConnectionCtx } from '../types.js'

export function registerGroups(socket: AppSocket, ctx: ConnectionCtx): void {
  const { clientId, myPub } = ctx

  socket.on('group-create', ({ name, members }: { name: string; members: string[] }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || typeof name !== 'string' || !name.trim() || !Array.isArray(members)) { cb?.(false); return }
    const id = `g-${randomUUID()}`
    const all = new Set([from, ...members.filter((m) => known.has(m) || online.has(m))])
    if (all.size < 2) { cb?.(false); return }
    groups.set(id, { name: name.trim().slice(0, 48), owner: from, members: all })
    store.saveGroup(id, name.trim().slice(0, 48), from, [...all])
    emitToMembers(id, 'group-added', groupInfo(id))
    cb?.(true)
  })

  socket.on('group-delete', ({ groupId }: { groupId: string }, cb?: (ok: boolean) => void) => {
    const g = groups.get(groupId)
    const from = clientId()
    if (!g || g.owner !== from) { cb?.(false); return }
    const by = online.get(from!)?.name
    emitToMembers(groupId, 'group-removed', { id: groupId, by })
    for (const m of g.members) {
      if (m === from) continue
      notifyOffline(m, 'group_activity', { title: g.name, body: `${by ?? 'Someone'} deleted the group`, tag: `group-${groupId}`, url: '/' })
    }
    groups.delete(groupId)
    store.deleteGroup(groupId)
    cb?.(true)
  })

  socket.on('group-leave', ({ groupId }: { groupId: string }, cb?: (ok: boolean) => void) => {
    const g = groups.get(groupId)
    const from = clientId()
    if (!g || !from || !g.members.has(from)) { cb?.(false); return }
    const leaverName = online.get(from)?.name
    emitToMembers(groupId, 'group-left', { id: groupId, memberId: from, name: leaverName })
    g.members.delete(from)
    if (g.members.size < 2) {
      emitToMembers(groupId, 'group-removed', { id: groupId })
      groups.delete(groupId)
      store.deleteGroup(groupId)
    } else {
      if (g.owner === from) g.owner = [...g.members][0]
      store.saveGroup(groupId, g.name, g.owner, [...g.members])
      emitToMembers(groupId, 'group-added', groupInfo(groupId))
      for (const m of g.members) {
        notifyOffline(m, 'group_activity', { title: g.name, body: `${leaverName ?? 'Someone'} left the group`, tag: `group-${groupId}`, url: '/' })
      }
    }
    cb?.(true)
  })

  socket.on('group-invite', ({ groupId, members }: { groupId: string; members: string[] }, cb?: (ok: boolean) => void) => {
    const g = groups.get(groupId)
    const from = clientId()
    if (!g || !from || !g.members.has(from) || !Array.isArray(members)) { cb?.(false); return }
    const added = members.filter((m) => (known.has(m) || online.has(m)) && !g.members.has(m))
    if (!added.length) { cb?.(false); return }
    added.forEach((m) => g.members.add(m))
    store.saveGroup(groupId, g.name, g.owner, [...g.members])
    const names = added.map((m) => online.get(m)?.name ?? known.get(m)?.name).join(', ')
    emitToMembers(groupId, 'group-added', groupInfo(groupId))
    for (const m of g.members) {
      if (added.includes(m)) {
        notifyOffline(m, 'group_activity', { title: g.name, body: 'You were added to the group', tag: `group-${groupId}`, url: '/' })
        continue
      }
      const u = online.get(m)
      if (u) io.to(u.socketId).emit('group-joined', { id: groupId, names })
      else notifyOffline(m, 'group_activity', { title: g.name, body: `${names} joined the group`, tag: `group-${groupId}`, url: '/' })
    }
    cb?.(true)
  })

  // mentions travels as plaintext member-id list alongside the (still
  // per-member-encrypted) payloads — purely so the server can route a
  // "you were mentioned" push without ever seeing message content.
  socket.on('gdm', ({ groupId, id, payloads, ts, mentions }: { groupId: string; id: string; payloads: Record<string, unknown>; ts: number; mentions?: string[] }) => {
    const from = clientId()
    const g = groups.get(groupId)
    if (!from || !g || !g.members.has(from) || !payloads) return
    const mentioned = new Set(Array.isArray(mentions) ? mentions : [])
    for (const [memberId, payload] of Object.entries(payloads)) {
      if (!g.members.has(memberId)) continue
      if (memberId === from) {
        store.saveMessage(id, from, from, myPub(), groupId, JSON.stringify(payload), ts, true)
        continue
      }
      const u = online.get(memberId)
      if (u) io.to(u.socketId).emit('gdm', { groupId, from, fromName: online.get(from)?.name, id, payload, ts })
      else if (mentioned.has(memberId)) {
        notifyOffline(memberId, 'mentions', {
          title: g.name,
          body: `${online.get(from)?.name ?? 'Someone'} mentioned you`,
          tag: `mention-${groupId}`, url: '/',
        })
      } else {
        notifyOffline(memberId, 'messages', {
          title: g.name,
          body: `${online.get(from)?.name ?? 'Someone'} sent a message`,
          tag: `group-${groupId}`, url: '/',
        })
      }
      store.saveMessage(id, memberId, from, myPub(), groupId, JSON.stringify(payload), ts, !!u)
    }
  })

  socket.on('gtyping', ({ groupId }: { groupId: string }) => {
    const from = clientId()
    if (!from || !groups.get(groupId)?.members.has(from)) return
    emitToMembers(groupId, 'gtyping', { groupId, from, name: online.get(from)?.name }, from)
  })

  for (const ev of ['gcall-ring', 'gcall-join', 'gcall-leave']) {
    socket.on(ev, ({ groupId, to }: { groupId: string; to?: string }) => {
      const from = clientId()
      const g = groups.get(groupId)
      if (!from || !g?.members.has(from)) return
      const data = { groupId, from, name: online.get(from)?.name }
      if (ev === 'gcall-ring' && to) {
        if (!g.members.has(to)) return
        const u = online.get(to)
        if (u) io.to(u.socketId).emit(ev, data)
        return
      }
      emitToMembers(groupId, ev, data, from)
    })
  }
}
