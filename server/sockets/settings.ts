import { randomUUID } from 'node:crypto'
import { io } from '../io.js'
import { store } from '../db.js'
import {
  makeRegistrationOptions, checkRegistration,
  makeAuthenticationOptions, checkAuthentication, toB64,
} from '../webauthn.js'
import { online, known, privacyCache, webauthnChallenges } from '../state.js'
import type { AppSocket, ConnectionCtx, PrivacyLevel, PasskeySummary, PasskeyCredentialRow } from '../types.js'

const passkeySummary = (rows: PasskeyCredentialRow[]): PasskeySummary[] =>
  rows.map((r) => ({ id: r.id, credentialId: r.credential_id, deviceType: r.device_type, createdAt: Number(r.created_at), lastUsed: r.last_used ? Number(r.last_used) : null }))

// Account settings & auth: passkeys, privacy, notification prefs, sessions,
// login history, profile, invitations, reporting, push subscriptions,
// delete-conversation, delete-account — the "everything about your account
// that isn't a live chat/call/group event" bucket.
export function registerSettings(socket: AppSocket, ctx: ConnectionCtx): void {
  const { clientId } = ctx

  // ---- passkeys ----
  // Challenges are short-lived and keyed by the identity attempting to
  // register/authenticate; one in-flight ceremony per identity at a time.
  const CHALLENGE_TTL = 300_000
  const freshChallenge = (key: string): string | null => {
    const entry = webauthnChallenges.get(key)
    if (!entry || Date.now() - entry.at > CHALLENGE_TTL) return null
    return entry.challenge
  }

  socket.on('webauthn-login-options', async ({ id }: { id: string }, cb: (res: unknown) => void) => {
    if (typeof cb !== 'function' || typeof id !== 'string') return
    const passkeys = await store.getPasskeysByUser(id)
    if (!passkeys.length) { cb({ noPasskey: true }); return }
    const options = await makeAuthenticationOptions(passkeys)
    webauthnChallenges.set(id, { challenge: options.challenge, at: Date.now() })
    cb({ options })
  })

  socket.on('webauthn-login-verify', async ({ id, name, username, pubKey, response }: { id: string; name?: string; username?: string; pubKey: object; response: Parameters<typeof checkAuthentication>[0] }, cb: (res: unknown) => void) => {
    if (typeof cb !== 'function' || typeof id !== 'string') return
    const expectedChallenge = freshChallenge(id)
    if (!expectedChallenge) { cb({ ok: false, error: 'This login attempt expired — try again' }); return }
    const passkeyRow = await store.getPasskeyByCredentialId(response?.id)
    if (!passkeyRow || passkeyRow.user_id !== id) { cb({ ok: false, error: 'Unrecognized passkey' }); return }

    let verification
    try {
      verification = await checkAuthentication(response, expectedChallenge, passkeyRow)
    } catch {
      cb({ ok: false, error: 'Passkey verification failed' })
      return
    }
    webauthnChallenges.delete(id)
    if (!verification.verified) { cb({ ok: false, error: 'Passkey verification failed' }); return }

    store.updatePasskeyCounter(passkeyRow.credential_id, verification.authenticationInfo.newCounter)
    socket.data.passkeyVerified = true
    await ctx.establishSession({
      id,
      cleanName: (name || '').trim().slice(0, 32) || id,
      cleanUsername: (username || '').trim().toLowerCase().slice(0, 32) || id,
      pubKey,
    })
    cb({ ok: true })
  })

  socket.on('webauthn-register-options', async (_data: unknown, cb: (res: unknown) => void) => {
    const from = clientId()
    if (!from || typeof cb !== 'function') return
    const existing = await store.getPasskeysByUser(from)
    const username = online.get(from)?.username ?? from
    const options = await makeRegistrationOptions(username, existing)
    webauthnChallenges.set(from, { challenge: options.challenge, at: Date.now() })
    cb({ options })
  })

  socket.on('webauthn-register-verify', async ({ response }: { response: Parameters<typeof checkRegistration>[0] }, cb: (res: unknown) => void) => {
    const from = clientId()
    if (!from || typeof cb !== 'function') return
    const expectedChallenge = freshChallenge(from)
    if (!expectedChallenge) { cb({ ok: false, error: 'This registration attempt expired — try again' }); return }

    let verification
    try {
      verification = await checkRegistration(response, expectedChallenge)
    } catch {
      cb({ ok: false, error: 'Could not verify passkey' })
      return
    }
    webauthnChallenges.delete(from)
    if (!verification.verified || !verification.registrationInfo) { cb({ ok: false, error: 'Could not verify passkey' }); return }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    store.savePasskey(
      randomUUID(), from, credential.id, toB64(credential.publicKey),
      credential.counter, credentialDeviceType, credentialBackedUp, credential.transports as string[] | undefined
    )
    cb({ ok: true })
  })

  socket.on('get-passkeys', async (_data: unknown, cb: (res: PasskeySummary[]) => void) => {
    const from = clientId()
    if (!from || typeof cb !== 'function') return
    cb(passkeySummary(await store.getPasskeysByUser(from)))
  })

  socket.on('delete-passkey', async ({ credentialId }: { credentialId: string }) => {
    const from = clientId()
    if (!from || !credentialId) return
    await store.deletePasskey(credentialId, from)
    socket.emit('passkeys', passkeySummary(await store.getPasskeysByUser(from)))
  })

  // ---- delete chat (soft, per-side; see getDeletedConversations comment in db.ts) ----
  socket.on('delete-conversation', async ({ peerId }: { peerId: string }) => {
    const from = clientId()
    if (!from || !peerId) return
    await store.deleteConversation(from, peerId)
  })

  // ---- push subscriptions ----
  socket.on('save-push-subscription', async ({ subscription }: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }) => {
    const from = clientId()
    if (!from || !subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) return
    store.savePushSubscription(randomUUID(), from, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth)
  })

  socket.on('delete-push-subscription', async ({ endpoint }: { endpoint: string }) => {
    if (!endpoint) return
    await store.deletePushSubscription(endpoint)
  })

  // ---- profile ----
  socket.on('update-profile', async ({ name, username, bio, avatar }: { name?: string; username?: string; bio?: string; avatar?: string }) => {
    const from = clientId()
    if (!from) return
    let cleanUsername = username
    if (username) {
      cleanUsername = username.trim().toLowerCase().slice(0, 32)
      const isAvailable = await store.checkUsernameAvailable(cleanUsername, from)
      if (!isAvailable) { socket.emit('profile-error', 'Username is already taken'); return }
    }
    const cleanName = name ? name.trim().slice(0, 32) : online.get(from)?.name
    await store.updateProfile(from, { name: cleanName!, username: cleanUsername!, bio: bio ? bio.trim().slice(0, 160) : '', avatar: avatar! })
    const onlineUser = online.get(from)
    if (onlineUser) {
      onlineUser.name = cleanName!
      if (cleanUsername) onlineUser.username = cleanUsername
    }
    socket.emit('profile-updated', await store.getUser(from))
  })

  // ---- invitations ----
  socket.on('create-invite', async (options: { expiresIn?: number } | undefined) => {
    const from = clientId()
    if (!from) return
    const code = randomUUID().split('-')[0]
    const expiresAt = options?.expiresIn ? Date.now() + options.expiresIn : null
    store.createInvite(randomUUID(), code, from, expiresAt)
    socket.emit('invite-created', { code, expiresAt })
  })

  socket.on('get-invite', async ({ code }: { code: string }, callback: (res: unknown) => void) => {
    if (!code || typeof callback !== 'function') return
    const invite = await store.getInvite(code)
    if (!invite) { callback({ error: 'Invite not found' }); return }
    if (invite.expires_at && invite.expires_at < Date.now()) { callback({ error: 'Invite expired' }); return }
    callback({ invite })
  })

  // ---- privacy settings ----
  socket.on('get-privacy-settings', async (callback?: (res: unknown) => void) => {
    const from = clientId()
    if (!from) return
    const settings = await store.getPrivacySettings(from)
    privacyCache.set(from, settings)
    if (typeof callback === 'function') callback(settings)
    else socket.emit('privacy-settings', settings)
  })

  socket.on('save-privacy-settings', async (settings: Record<string, string>) => {
    const from = clientId()
    if (!from) return
    const valid: PrivacyLevel[] = ['everyone', 'contacts', 'nobody']
    const isValid = (v: string): v is PrivacyLevel => (valid as string[]).includes(v)
    const cleaned = {
      message_privacy:   isValid(settings.message_privacy)   ? settings.message_privacy   : 'everyone' as const,
      call_privacy:      isValid(settings.call_privacy)      ? settings.call_privacy      : 'everyone' as const,
      last_seen_privacy: isValid(settings.last_seen_privacy) ? settings.last_seen_privacy : 'everyone' as const,
      online_privacy:    isValid(settings.online_privacy)    ? settings.online_privacy    : 'everyone' as const,
      avatar_privacy:    isValid(settings.avatar_privacy)    ? settings.avatar_privacy    : 'everyone' as const,
      bio_privacy:       isValid(settings.bio_privacy)       ? settings.bio_privacy       : 'everyone' as const,
    }
    await store.savePrivacySettings(from, cleaned)
    privacyCache.set(from, { user_id: from, ...cleaned })
    socket.emit('privacy-settings', { user_id: from, ...cleaned })
  })

  // ---- reporting ----
  socket.on('report-user', async ({ reportedId, category, details }: { reportedId: string; category: string; details?: string }) => {
    const from = clientId()
    if (!from || !reportedId || from === reportedId) return
    const validCategories = ['spam', 'harassment', 'fake_account', 'inappropriate_content', 'scam', 'other']
    if (!validCategories.includes(category)) return
    store.createReport(randomUUID(), from, reportedId, category, details?.slice(0, 500) || null)
    socket.emit('report-sent', { ok: true })
  })

  // ---- notification preferences ----
  socket.on('get-notification-prefs', async (callback?: (res: unknown) => void) => {
    const from = clientId()
    if (!from) return
    const prefs = await store.getNotificationPrefs(from)
    if (typeof callback === 'function') callback(prefs)
    else socket.emit('notification-prefs', prefs)
  })

  socket.on('save-notification-prefs', async (prefs: Record<string, boolean>) => {
    const from = clientId()
    if (!from) return
    await store.saveNotificationPrefs(from, {
      messages:         prefs.messages         !== false,
      calls:            prefs.calls            !== false,
      contact_requests: prefs.contact_requests !== false,
      mentions:         prefs.mentions         !== false,
      group_activity:   prefs.group_activity   !== false,
      announcements:    prefs.announcements    !== false,
    })
    socket.emit('notification-prefs', await store.getNotificationPrefs(from))
  })

  // ---- sessions ----
  socket.on('get-sessions', async (callback?: (res: unknown) => void) => {
    const from = clientId()
    if (!from) return
    const sessions = await store.getSessions(from)
    const currentSessionId = socket.data.sessionId
    const result = sessions.map(s => ({ ...s, isCurrent: s.id === currentSessionId }))
    if (typeof callback === 'function') callback(result)
    else socket.emit('sessions', result)
  })

  socket.on('get-login-history', async (callback?: (res: unknown) => void) => {
    const from = clientId()
    if (!from) return
    const history = await store.getLoginHistory(from)
    if (typeof callback === 'function') callback(history)
    else socket.emit('login-history', history)
  })

  socket.on('revoke-session', async ({ sessionId }: { sessionId: string }) => {
    const from = clientId()
    if (!from || !sessionId) return
    // Can't revoke your own current session this way (use sign-out for that)
    if (sessionId === socket.data.sessionId) return
    await store.revokeSession(sessionId, from)
    // Kick that socket if it's still connected
    for (const [, s] of io.sockets.sockets) {
      if (s.data.sessionId === sessionId && s.data.clientId === from) {
        s.emit('session-revoked')
        s.disconnect(true)
      }
    }
    socket.emit('sessions', (await store.getSessions(from)).map(s => ({ ...s, isCurrent: s.id === socket.data.sessionId })))
  })

  socket.on('revoke-all-sessions', async () => {
    const from = clientId()
    if (!from) return
    await store.revokeAllSessionsExcept(from, socket.data.sessionId!)
    // Kick all other sockets for this user
    for (const [, s] of io.sockets.sockets) {
      if (s.data.clientId === from && s.id !== socket.id) {
        s.emit('session-revoked')
        s.disconnect(true)
      }
    }
    socket.emit('sessions', (await store.getSessions(from)).map(s => ({ ...s, isCurrent: s.id === socket.data.sessionId })))
  })

  // ---- account deletion ----
  socket.on('delete-account', async () => {
    const from = clientId()
    if (!from) return
    await store.deleteAccount(from)
    // Clean up in-memory presence
    online.delete(from)
    known.delete(from)
    privacyCache.delete(from)
    // Notify contacts that user went offline
    const contacts = await store.getContacts(from)
    for (const c of contacts) {
      const peerId = c.requester_id === from ? c.recipient_id : c.requester_id
      const peerSocket = online.get(peerId)
      if (peerSocket) io.to(peerSocket.socketId).emit('presence', { id: from, online: false, lastSeen: null })
    }
    socket.emit('account-deleted')
    socket.disconnect(true)
  })
}
