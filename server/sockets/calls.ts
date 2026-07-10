import { randomUUID } from 'node:crypto'
import { io } from '../io.js'
import { store } from '../db.js'
import { online, privacyCache } from '../state.js'
import { privacyAllows } from '../helpers.js'
import { notifyOffline } from '../notify.js'
import { flagEnabled } from '../flags.js'
import { recordCall } from '../metrics.js'
import type { AppSocket, ConnectionCtx } from '../types.js'

interface RoutedMsg {
  to: string
  [key: string]: unknown
}

// This is the module Phase 4's calling features extend — call-offer/answer/
// ice/end/decline plus the group-mesh presence signals (share/cam/mic state).
//
// Call analytics (answered/missed/declined, duration) are correlated
// server-side from these existing signaling messages alone — no callId from
// the client, no change to the live call state machine. findOpenCall() looks
// up the most recent non-ended row between the same pair, in either
// direction, which works because this app only ever allows one active call
// per pair at a time.
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
  for (const ev of ['call-ice', 'cam-state', 'mic-state']) {
    socket.on(ev, route(ev))
  }
  // the flag can't stop local getDisplayMedia(), but it can stop the "I'm
  // sharing" announcement from ever reaching the peer
  socket.on('share-state', (msg: RoutedMsg) => { if (flagEnabled('screen_share')) route('share-state')(msg) })

  socket.on('call-answer', async (msg: RoutedMsg) => {
    const from = clientId()
    if (!from) return
    const open = await store.findOpenCall(from, msg.to)
    if (open) store.markCallAnswered(open.id)
    await route('call-answer')(msg)
  })

  socket.on('call-decline', async (msg: RoutedMsg) => {
    const from = clientId()
    if (!from) return
    const open = await store.findOpenCall(from, msg.to)
    if (open && open.status === 'ringing') store.endCall(open.id, 'declined')
    await route('call-decline')(msg)
  })

  socket.on('call-end', async (msg: RoutedMsg) => {
    const from = clientId()
    if (!from) return
    const open = await store.findOpenCall(from, msg.to)
    if (open) store.endCall(open.id, open.status === 'answered' ? 'completed' : 'missed')
    await route('call-end')(msg)
  })

  // reads getStats() locally and reports which candidate type won, once per
  // call — see the matching addition in useCall.ts's existing quality poll
  socket.on('call-relay-info', async ({ to, relay }: { to: string; relay: 'p2p' | 'turn' }) => {
    const from = clientId()
    if (!from || (relay !== 'p2p' && relay !== 'turn')) return
    const open = await store.findOpenCall(from, to)
    if (open) store.setCallRelay(open.id, relay)
  })

  // call-offer: enforce call_privacy + the voice/video kill switches
  socket.on('call-offer', async (msg: RoutedMsg) => {
    const from = clientId()
    if (!from || !msg?.to) return
    if (!msg.restart && !flagEnabled(msg.video === false ? 'voice_calls' : 'video_calls')) {
      socket.emit('call-declined', { from: msg.to, reason: 'disabled' })
      return
    }
    const target = online.get(msg.to)
    if (!target) {
      notifyOffline(msg.to, 'calls', {
        title: 'Missed call',
        body: `${online.get(from)?.name ?? 'Someone'} tried to call you`,
        tag: `call-${from}`, url: '/',
      })
      if (!msg.restart && !msg.group) { store.logCall(randomUUID(), from, msg.to, null, msg.video !== false); recordCall() }
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
    if (!msg.restart && !msg.group) { store.logCall(randomUUID(), from, msg.to, null, msg.video !== false); recordCall() }
    io.to(target.socketId).emit('call-offer', { ...msg, from, fromName: online.get(from)?.name })
  })
}
