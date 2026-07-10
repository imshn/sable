import { randomUUID } from 'node:crypto'
import { io } from '../io.js'
import { store } from '../db.js'
import { online, privacyCache } from '../state.js'
import { privacyAllows } from '../helpers.js'
import { notifyOffline } from '../notify.js'
import type { AppSocket, ConnectionCtx } from '../types.js'

interface RoutedMsg {
  to: string
  [key: string]: unknown
}

// This is the module Phase 4's calling features extend — call-offer/answer/
// ice/end/decline plus the group-mesh presence signals (share/cam/mic state).
export function registerCalls(socket: AppSocket, ctx: ConnectionCtx): void {
  const { clientId, getContact } = ctx

  // Generic 1:1 signaling relay: just requires an accepted contact between
  // the two parties, then forwards the payload verbatim plus from/fromName.
  const route = (event: string) => async (msg: RoutedMsg) => {
    const from = clientId()
    const target = from && msg && online.get(msg.to)
    if (!target) return
    const contact = await getContact(from!, msg.to)
    if (!contact || contact.status !== 'accepted') return
    io.to(target.socketId).emit(event, { ...msg, from, fromName: online.get(from!)?.name })
  }

  socket.on('typing', route('typing'))
  for (const ev of ['call-answer', 'call-ice', 'call-end', 'call-decline', 'share-state', 'cam-state', 'mic-state']) {
    socket.on(ev, route(ev))
  }

  // call-offer: enforce call_privacy
  socket.on('call-offer', async (msg: RoutedMsg) => {
    const from = clientId()
    if (!from || !msg?.to) return
    const target = online.get(msg.to)
    if (!target) {
      notifyOffline(msg.to, 'calls', {
        title: 'Missed call',
        body: `${online.get(from)?.name ?? 'Someone'} tried to call you`,
        tag: `call-${from}`, url: '/',
      })
      return
    }
    const contact = await getContact(from, msg.to)
    if (!contact || contact.status !== 'accepted') return

    // Respect the callee's call_privacy setting
    const targetPrivacy = privacyCache.get(msg.to) || await store.getPrivacySettings(msg.to)
    const isContact = contact?.status === 'accepted'
    if (!privacyAllows(targetPrivacy?.call_privacy ?? 'everyone', isContact)) {
      socket.emit('call-declined', { from: msg.to, reason: 'privacy' })
      return
    }
    // analytics: a fresh 1:1 ring that actually reached the callee — not ICE
    // restarts or group-mesh offers (those re-use call-offer as plumbing)
    if (!msg.restart && !msg.group) store.logCall(randomUUID(), from, msg.to, null, msg.video !== false)
    io.to(target.socketId).emit('call-offer', { ...msg, from, fromName: online.get(from)?.name })
  })
}
