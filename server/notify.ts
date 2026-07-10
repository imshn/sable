import { randomUUID } from 'node:crypto'
import { io } from './io.js'
import { store } from './db.js'
import { sendPush } from './push.js'
import { online, privacyCache } from './state.js'
import { privacyAllows } from './helpers.js'
import { flagEnabled } from './flags.js'
import type { PushPayload, NotificationPrefsRow } from './types.js'

// ------------------------------------------------------------------
// Presence notification (respects online_privacy)
// ------------------------------------------------------------------

export const notifyPresence = async (userId: string, onlineState: boolean, lastSeen: number): Promise<void> => {
  const userPrivacy = privacyCache.get(userId) || await store.getPrivacySettings(userId)
  privacyCache.set(userId, userPrivacy)

  const contacts = await store.getContacts(userId)
  for (const c of contacts) {
    if (c.status !== 'accepted') continue
    const peerId = c.requester_id === userId ? c.recipient_id : c.requester_id
    const peerSocket = online.get(peerId)
    if (!peerSocket) continue

    // Respect online_privacy: if set to 'nobody', always appear offline to everyone
    // If 'contacts', peerId is an accepted contact so allowed
    const isContact = true // we're already inside accepted contacts loop
    const showOnline = privacyAllows(userPrivacy?.online_privacy ?? 'everyone', isContact)
    const showLastSeen = privacyAllows(userPrivacy?.last_seen_privacy ?? 'everyone', isContact)

    io.to(peerSocket.socketId).emit('presence', {
      id: userId,
      online: showOnline ? onlineState : false,
      lastSeen: showLastSeen ? lastSeen : null,
    })
  }
}

async function pushToSubscriptions(userId: string, prefKey: keyof NotificationPrefsRow, payload: PushPayload): Promise<void> {
  if (!flagEnabled('push_notifications')) return
  const prefs = await store.getNotificationPrefs(userId)
  if (prefs && prefs[prefKey] === 0) return
  const subs = await store.getPushSubscriptions(userId)
  for (const sub of subs) {
    const result = await sendPush(sub, payload)
    store.logPush(randomUUID(), userId, payload.tag, result.ok, !!result.expired)
    if (result.expired) store.deletePushSubscription(sub.endpoint)
  }
}

// Buzzes a device when the app itself can't: zero live sockets for this
// user, so no in-app UI is around to show anything. Payload is metadata
// only (sender name, never message text) — the server still can't read
// message content, so it can't put it in a push either.
export async function notifyOffline(userId: string, prefKey: keyof NotificationPrefsRow, payload: PushPayload): Promise<void> {
  if (online.has(userId)) return
  await pushToSubscriptions(userId, prefKey, payload)
}

// For dm/gdm: a live socket isn't the same as looking at this conversation
// — a message that lands on a thread the recipient doesn't currently have
// open still deserves a push, same as if they were offline. `threadKey` is
// the peerId (dm) or groupId (gdm) the message belongs to.
export async function notifyIfNotViewing(userId: string, threadKey: string, prefKey: keyof NotificationPrefsRow, payload: PushPayload): Promise<void> {
  const user = online.get(userId)
  if (user && user.activeThread === threadKey) return
  await pushToSubscriptions(userId, prefKey, payload)
}

// ponytail: allUsers() caps at 200 most-recently-active — fine for this
// app's scale, revisit with a paged sweep if the user base outgrows it.
export async function broadcastAnnouncement(title: string, body: string): Promise<number> {
  const payload = { title, body, ts: Date.now() }
  const users = await store.allUsers()
  let notified = 0
  for (const u of users) {
    const onlineInfo = online.get(u.id)
    const prefs = await store.getNotificationPrefs(u.id)
    if (prefs && prefs.announcements === 0) continue
    if (onlineInfo) io.to(onlineInfo.socketId).emit('announcement', payload)
    else await notifyOffline(u.id, 'announcements', { title, body: body.slice(0, 120), tag: 'announcement', url: '/' })
    notified++
  }
  return notified
}
