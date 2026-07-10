import { io } from '../io.js'
import { store } from '../db.js'
import { online, known, privacyCache } from '../state.js'
import { privacyAllows } from '../helpers.js'
import { notifyIfNotViewing } from '../notify.js'
import { recordMessage } from '../metrics.js'
import type { AppSocket, ConnectionCtx } from '../types.js'

interface EncryptedPayloadArg {
  iv: string
  ct: string
}

export function registerMessages(socket: AppSocket, ctx: ConnectionCtx): void {
  const { clientId, myPub, getContact } = ctx

  // dm: enforce message_privacy + contact status
  socket.on('dm', async ({ to, id, payload, selfPayload, ts }: { to: string; id: string; payload: EncryptedPayloadArg; selfPayload?: EncryptedPayloadArg; ts: number }) => {
    const from = clientId()
    if (!from || !to || !payload) return
    const contact = await getContact(from, to)
    if (!contact || contact.status !== 'accepted') return

    // Respect recipient's message_privacy
    const targetPrivacy = privacyCache.get(to) || await store.getPrivacySettings(to)
    if (!privacyAllows(targetPrivacy?.message_privacy ?? 'everyone', contact.status === 'accepted')) return

    const recipient = online.get(to)
    const wasRouted = !!recipient
    if (recipient) {
      io.to(recipient.socketId).emit('dm', { from, fromName: online.get(from)?.name, id, payload, ts })
    }
    notifyIfNotViewing(to, from, 'messages', {
      title: online.get(from)?.name ?? 'New message',
      body: 'Sent you a message',
      tag: `dm-${from}`, url: '/',
    })
    if (known.has(to) || wasRouted) {
      store.saveMessage(id, to, from, myPub(), null, JSON.stringify(payload), ts, false)
    }
    if (selfPayload) store.saveMessage(id, from, from, myPub(), null, JSON.stringify(selfPayload), ts, true)
    recordMessage()
  })

  socket.on('delivered', ({ to, msgId }: { to: string; msgId: string }) => {
    const from = clientId()
    if (!from || !to) return
    store.markDelivered(msgId, from)
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('delivered', { from, msgId })
  })
}
