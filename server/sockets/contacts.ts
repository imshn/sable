import { io } from '../io.js'
import { store } from '../db.js'
import { online, privacyCache } from '../state.js'
import { privacyAllows } from '../helpers.js'
import { notifyOffline, notifyPresence } from '../notify.js'
import type { AppSocket, ConnectionCtx } from '../types.js'

export function registerContacts(socket: AppSocket, ctx: ConnectionCtx): void {
  const { clientId, getContactsWithPresence } = ctx

  socket.on('contact-request', async ({ to }: { to: string }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || !to || from === to) { cb?.(false); return }

    // Check if already blocked
    const existing = await store.getContacts(from)
    const rel = existing.find(c => c.requester_id === to || c.recipient_id === to)
    if (rel && rel.status === 'blocked') { cb?.(false); return }

    // Respect target's message_privacy: if 'nobody', can't be messaged/contacted
    const targetPrivacy = privacyCache.get(to) || await store.getPrivacySettings(to)
    const isContact = rel?.status === 'accepted'
    if (!privacyAllows(targetPrivacy?.message_privacy ?? 'everyone', isContact ?? false)) { cb?.(false); return }

    await store.upsertContact(from, to, 'pending')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    else notifyOffline(to, 'contact_requests', {
      title: 'New contact request',
      body: `${online.get(from)?.name ?? 'Someone'} wants to connect`,
      tag: `contact-${from}`, url: '/',
    })
    socket.emit('contact-updated', await getContactsWithPresence(from))
    cb?.(true)
  })

  socket.on('contact-accept', async ({ to }: { to: string }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || !to) { cb?.(false); return }
    await store.upsertContact(to, from, 'accepted')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
    notifyPresence(from, true, Date.now())
    cb?.(true)
  })

  socket.on('contact-reject', async ({ to }: { to: string }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || !to) { cb?.(false); return }
    await store.upsertContact(to, from, 'rejected')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
    cb?.(true)
  })

  socket.on('contact-remove', async ({ to }: { to: string }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || !to) { cb?.(false); return }
    await store.deleteContact(from, to)
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
    cb?.(true)
  })

  socket.on('contact-block', async ({ to }: { to: string }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || !to) { cb?.(false); return }
    await store.upsertContact(from, to, 'blocked')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
    cb?.(true)
  })

  socket.on('contact-unblock', async ({ to }: { to: string }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || !to) { cb?.(false); return }
    await store.deleteContact(from, to)
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
    cb?.(true)
  })

  // Sets how a contact appears to ME only — never touches their real
  // profile, never visible to them or anyone else, so no broadcast to `to`.
  socket.on('set-contact-nickname', async ({ to, nickname }: { to: string; nickname: string }, cb?: (ok: boolean) => void) => {
    const from = clientId()
    if (!from || !to) { cb?.(false); return }
    await store.setContactNickname(from, to, (nickname || '').trim().slice(0, 48))
    socket.emit('contact-updated', await getContactsWithPresence(from))
    cb?.(true)
  })
}
