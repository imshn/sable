import { randomUUID } from 'node:crypto'
import { io } from '../io.js'
import { store } from '../db.js'
import { online, known, groups, privacyCache } from '../state.js'
import { parseDeviceHint, groupInfo, privacyAllows } from '../helpers.js'
import { notifyPresence } from '../notify.js'
import { flagEnabled } from '../flags.js'
import type { AppSocket, ConnectionCtx, ContactRow, ContactWithPresence } from '../types.js'

// Connection lifecycle: builds the shared per-connection ctx (clientId,
// getContact, establishSession, ...) that every other domain module uses,
// registers `hello` (auth + session creation) and `disconnect`.
export function registerPresence(socket: AppSocket): ConnectionCtx {
  const ip = (socket.handshake.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
             || socket.handshake.address
  const ua = socket.handshake.headers['user-agent'] || ''
  const deviceHint = parseDeviceHint(ua)

  // Only accepted contacts ever see each other's online/last-seen state, and
  // even then only what the peer's own privacy settings allow — mirrors
  // notifyPresence's live broadcast so the initial snapshot can't leak more
  // than a subsequent presence event would.
  const getContactsWithPresence = async (userId: string): Promise<ContactWithPresence[]> => {
    const [contacts, nicknames] = await Promise.all([store.getContacts(userId), store.getContactNicknames(userId)])
    // one bulk query for whichever peers aren't already in the privacy cache
    const uncached = contacts
      .map(c => (c.requester_id === userId ? c.recipient_id : c.requester_id))
      .filter(id => !privacyCache.has(id))
    if (uncached.length) {
      const rows = await store.getPrivacySettingsBulk(uncached)
      for (const id of uncached) {
        privacyCache.set(id, rows.get(id) ?? {
          user_id: id, message_privacy: 'everyone', call_privacy: 'everyone',
          last_seen_privacy: 'everyone', online_privacy: 'everyone',
          avatar_privacy: 'everyone', bio_privacy: 'everyone',
        })
      }
    }
    return contacts.map(c => {
      const isRequester = c.requester_id === userId
      const peerId = isRequester ? c.recipient_id : c.requester_id
      const isAccepted = c.status === 'accepted'
      const peerPrivacy = privacyCache.get(peerId)
      const showOnline = isAccepted && privacyAllows(peerPrivacy?.online_privacy ?? 'everyone', true) && online.has(peerId)
      const showLastSeen = isAccepted && privacyAllows(peerPrivacy?.last_seen_privacy ?? 'everyone', true)
      const peerLastSeenField = isRequester ? 'recipient_last_seen' : 'requester_last_seen'
      return {
        ...c,
        [peerLastSeenField]: showLastSeen ? c[peerLastSeenField] : null,
        online: showOnline,
        nickname: nicknames[peerId] ?? null,
      }
    })
  }

  // Single-row relationship lookup — hot path, runs on every dm/call packet
  const getContact = (fromId: string, toId: string): Promise<ContactRow | null> =>
    store.getContactPair(fromId, toId)

  // Shared by plain login and passkey-verified login: creates the session
  // record, warms caches, and sends the initial state batch.
  const establishSession = async ({ id, cleanName, cleanUsername, pubKey, via = 'passwordless' }: { id: string; cleanName: string; cleanUsername: string; pubKey: object; via?: 'passkey' | 'passwordless' }) => {
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
    store.createSession(sessionId, id, socket.id, ip, ua, deviceHint, via)

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

    // 10+ failed attempts from this IP in 10 minutes: stop even trying —
    // the security dashboard's "blocked IPs" reflects this, not just a label
    if (await store.countRecentFailedLogins(ip, 600_000) >= 10) {
      socket.emit('auth-error', 'Too many attempts — try again later')
      return
    }

    const cleanName = name.trim().slice(0, 32)
    const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 32) : `user_${id.slice(0, 6)}`

    const existingUser = await store.getUser(id)

    if (!existingUser && !flagEnabled('registration')) {
      socket.emit('auth-error', 'New sign-ups are temporarily disabled')
      store.logFailedLogin(randomUUID(), id, ip, 'registration_disabled')
      return
    }

    if (existingUser?.suspended) {
      socket.emit('auth-error', 'This account has been suspended')
      store.logFailedLogin(randomUUID(), id, ip, 'suspended')
      return
    }

    const isAvailable = await store.checkUsernameAvailable(cleanUsername, id)
    if (!isAvailable) {
      socket.emit('auth-error', 'Username is already taken')
      store.logFailedLogin(randomUUID(), id, ip, 'username_taken')
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

  // Lets dm/gdm tell a push apart from "they're already looking at this" —
  // set whenever the client opens/closes a thread, including to null.
  socket.on('set-active-thread', ({ id }: { id: string | null }) => {
    const clientId = socket.data.clientId
    if (!clientId) return
    const me = online.get(clientId)
    if (me) me.activeThread = id ?? null
  })

  // Page Visibility API state — lets call-offer decide whether a backgrounded
  // tab still needs an OS-level ring push on top of the live socket event.
  socket.on('set-visibility', ({ visible }: { visible: boolean }) => {
    const clientId = socket.data.clientId
    if (!clientId) return
    const me = online.get(clientId)
    if (me) me.visible = !!visible
  })

  // Real per-notification open tracking, reported by the service worker's
  // notificationclick — no identity needed, the id alone is enough to mark
  // the right push_log row (see server/notify.ts's pushToSubscriptions).
  socket.on('push-opened', ({ id }: { id: string }) => {
    if (typeof id === 'string' && id) store.markPushOpened(id)
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
