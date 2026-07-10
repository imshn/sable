import { randomUUID } from 'node:crypto'
import { io } from '../io.js'
import { store } from '../db.js'
import { online, known, groups, privacyCache } from '../state.js'
import { parseDeviceHint, groupInfo } from '../helpers.js'
import { notifyPresence } from '../notify.js'
import type { AppSocket, ConnectionCtx, ContactRow, ContactWithPresence } from '../types.js'

// Connection lifecycle: builds the shared per-connection ctx (clientId,
// getContact, establishSession, ...) that every other domain module uses,
// registers `hello` (auth + session creation) and `disconnect`.
export function registerPresence(socket: AppSocket): ConnectionCtx {
  const ip = (socket.handshake.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
             || socket.handshake.address
  const ua = socket.handshake.headers['user-agent'] || ''
  const deviceHint = parseDeviceHint(ua)

  const getContactsWithPresence = async (userId: string): Promise<ContactWithPresence[]> => {
    const [contacts, nicknames] = await Promise.all([store.getContacts(userId), store.getContactNicknames(userId)])
    return contacts.map(c => {
      const peerId = c.requester_id === userId ? c.recipient_id : c.requester_id
      return { ...c, online: online.has(peerId), nickname: nicknames[peerId] ?? null }
    })
  }

  // Resolve relationship: returns contact row or null
  const getContact = async (fromId: string, toId: string): Promise<ContactRow | null> => {
    const contacts = await store.getContacts(fromId)
    return contacts.find(c =>
      (c.requester_id === fromId && c.recipient_id === toId) ||
      (c.recipient_id === fromId && c.requester_id === toId)
    ) || null
  }

  // Shared by plain login and passkey-verified login: creates the session
  // record, warms caches, and sends the initial state batch.
  const establishSession = async ({ id, cleanName, cleanUsername, pubKey }: { id: string; cleanName: string; cleanUsername: string; pubKey: object }) => {
    const prev = online.get(id)
    if (prev && prev.socketId !== socket.id) {
      const old = io.sockets.sockets.get(prev.socketId)
      old?.emit('session-replaced')
      old?.disconnect(true)
      if (prev.sessionId) store.revokeSession(prev.sessionId, id)
    }

    const sessionId = randomUUID()
    socket.data.clientId = id
    socket.data.sessionId = sessionId
    store.createSession(sessionId, id, socket.id, ip, ua, deviceHint)

    online.set(id, { socketId: socket.id, name: cleanName, username: cleanUsername, pubKey, sessionId })
    known.set(id, { name: cleanName, username: cleanUsername, pubKey, lastSeen: Date.now() })
    store.upsertUser(id, cleanName, JSON.stringify(pubKey), cleanUsername)

    const privacy = await store.getPrivacySettings(id)
    privacyCache.set(id, privacy)

    const contacts = await getContactsWithPresence(id)
    socket.emit('contacts', contacts)
    notifyPresence(id, true, Date.now())

    for (const [gid, g] of groups) {
      if (g.members.has(id)) socket.emit('group-added', groupInfo(gid))
    }

    const deletedRows = await store.getDeletedConversations(id)
    const deletedAt = Object.fromEntries(deletedRows.map((r) => [r.peer_id, Number(r.deleted_at)]))
    socket.emit('deleted-conversations', deletedAt)

    const rows = await store.backlog(id)
    const undelivered = await store.undeliveredSenders(id)
    socket.emit('backlog', rows.map((r) => ({
      id: r.id,
      from: r.sender,
      fromName: known.get(r.sender)?.name ?? 'unknown',
      senderPub: JSON.parse(r.sender_pub),
      groupId: r.group_id,
      payload: JSON.parse(r.payload),
      delivered: !!r.delivered,
      ts: Number(r.ts),
    })))
    for (const row of undelivered) {
      store.markDelivered(row.id, id)
      const sender = online.get(row.sender)
      if (sender) io.to(sender.socketId).emit('delivered', { from: id, msgId: row.id })
    }

    const myProfile = await store.getUser(id)
    if (myProfile) socket.emit('profile', myProfile)

    socket.emit('privacy-settings', privacy)
    const notifPrefs = await store.getNotificationPrefs(id)
    socket.emit('notification-prefs', notifPrefs)
  }

  // ---- hello (auth + session creation) ----
  socket.on('hello', async ({ id, name, username, pubKey }: { id: string; name: string; username?: string; pubKey: object }) => {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || !pubKey) return
    const cleanName = name.trim().slice(0, 32)
    const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 32) : `user_${id.slice(0, 6)}`

    const isAvailable = await store.checkUsernameAvailable(cleanUsername, id)
    if (!isAvailable) {
      socket.emit('auth-error', 'Username is already taken')
      return
    }

    // A registered passkey gates entry: proving the name is not enough once
    // one exists. The client completes the ceremony, then calls
    // webauthn-login-verify, which establishes the session on success.
    const passkeys = await store.getPasskeysByUser(id)
    if (passkeys.length > 0 && !socket.data.passkeyVerified) {
      socket.emit('passkey-required', { id })
      return
    }

    await establishSession({ id, cleanName, cleanUsername, pubKey })
  })

  // ---- disconnect ----
  socket.on('disconnect', () => {
    const id = socket.data.clientId
    if (id && online.get(id)?.socketId === socket.id) {
      const sessionId = socket.data.sessionId
      online.delete(id)
      const k = known.get(id)
      if (k) k.lastSeen = Date.now()
      store.touchUser(id)
      if (sessionId) store.touchSession(sessionId)
      notifyPresence(id, false, Date.now())
    }
  })

  return {
    ip,
    ua,
    deviceHint,
    clientId: () => socket.data.clientId,
    myPub: () => JSON.stringify(online.get(socket.data.clientId ?? '')?.pubKey ?? null),
    getContact,
    getContactsWithPresence,
    establishSession,
  }
}
