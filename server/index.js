// Sable relay server — routes ciphertext, public keys, and WebRTC signaling.
// With Turso configured it also persists ciphertext history and offline
// deliveries; the server still cannot read any message content.
import { Server } from 'socket.io'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { migrate, store } from './db.js'

const PORT = process.env.PORT || 3001

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const metaTags = (html) => {
  const tags = {}
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0]
    const key = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase()
    const content = tag.match(/content=["']([^"']*)["|']/i)?.[1]
    if (key && content && !tags[key]) tags[key] = content
  }
  return tags
}

const decodeEntities = (s) =>
  s?.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" })[m])

// TURN server credentials (Cloudflare Realtime)
let turnCache = { at: 0, servers: [] }
async function turnServers() {
  if (Date.now() - turnCache.at < 3600_000) return turnCache.servers
  let servers = []
  try {
    if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 7200 }),
          signal: AbortSignal.timeout(6000),
        }
      )
      const body = await r.json()
      if (r.ok && Array.isArray(body.iceServers)) servers = body.iceServers
      else console.error('cloudflare turn mint failed', r.status, JSON.stringify(body).slice(0, 200))
    }
  } catch (e) { console.error('turn fetch failed', e.message) }
  turnCache = { at: servers.length ? Date.now() : Date.now() - 3540_000, servers }
  return servers
}

// Parse a User-Agent string into a human-readable device hint
function parseDeviceHint(ua = '') {
  if (!ua) return 'Unknown device'
  let os = 'Unknown OS'
  let browser = 'Unknown browser'
  if (/windows/i.test(ua)) os = 'Windows'
  else if (/macintosh|mac os/i.test(ua)) os = 'macOS'
  else if (/linux/i.test(ua)) os = 'Linux'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/iphone|ipad/i.test(ua)) os = 'iOS'
  if (/edg\//i.test(ua)) browser = 'Edge'
  else if (/chrome/i.test(ua)) browser = 'Chrome'
  else if (/firefox/i.test(ua)) browser = 'Firefox'
  else if (/safari/i.test(ua)) browser = 'Safari'
  return `${browser} on ${os}`
}

// Privacy enforcement helper
// allowed: 'everyone' | 'contacts' | 'nobody'
// relationship: whether the querier is an accepted contact
function privacyAllows(setting, isContact) {
  if (setting === 'everyone') return true
  if (setting === 'contacts') return isContact
  return false // 'nobody'
}

// ------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------

process.on('uncaughtException', (e) => console.error('uncaughtException', e))
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e))
const BOOT_ID = randomUUID().slice(0, 8)

const httpServer = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://relay')
    res.setHeader('Access-Control-Allow-Origin', '*')

    if (u.pathname === '/healthz') {
      res.writeHead(200)
      return res.end(JSON.stringify({ ok: true, boot: BOOT_ID, up: Math.round(process.uptime()) }))
    }

    if (u.pathname === '/turn') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify(await turnServers()))
    }

    if (u.pathname === '/api/search') {
      res.setHeader('Content-Type', 'application/json')
      const q = u.searchParams.get('q')
      const uid = u.searchParams.get('uid')
      if (typeof q !== 'string' || q.trim().length < 2) return res.end('[]')
      const cleanQuery = q.trim().replace(/^@/, '')
      if (cleanQuery.length < 2) return res.end('[]')
      const results = await store.searchUsers(cleanQuery, uid)
      return res.end(JSON.stringify(results))
    }

    if (u.pathname !== '/preview') {
      res.writeHead(404)
      return res.end()
    }
    res.setHeader('Content-Type', 'application/json')
    const target = new URL(u.searchParams.get('url'))
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol')
    const r = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SablePreview/1.0)', accept: 'text/html' },
    })
    if (!(r.headers.get('content-type') ?? '').includes('text/html')) throw new Error('not html')
    const html = (await r.text()).slice(0, 400_000)
    const tags = metaTags(html)
    const title = decodeEntities(tags['og:title'] ?? tags['twitter:title'] ?? html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim())
    const description = decodeEntities(tags['og:description'] ?? tags['twitter:description'] ?? tags.description)
    let image = tags['og:image'] ?? tags['twitter:image']
    if (image) image = new URL(image, r.url ?? target).href
    res.end(JSON.stringify({ title, description, image, site: decodeEntities(tags['og:site_name']) }))
  } catch {
    res.end('{}')
  }
})

const io = new Server(httpServer, {
  cors: { origin: true },
  maxHttpBufferSize: 40e6,
})

// ------------------------------------------------------------------
// In-memory presence
// ------------------------------------------------------------------

const online = new Map()  // clientId -> { socketId, name, pubKey, sessionId }
const known  = new Map()  // clientId -> { name, pubKey, lastSeen }
const groups = new Map()  // groupId  -> { name, owner, members: Set<clientId> }

// Privacy settings cache to avoid hitting DB on every message
const privacyCache = new Map() // clientId -> privacy_settings row

await migrate()
for (const u of await store.allUsers()) {
  known.set(u.id, { name: u.name, pubKey: JSON.parse(u.pubkey), lastSeen: Number(u.last_seen) })
}
for (const g of await store.loadGroups()) {
  groups.set(g.id, { name: g.name, owner: g.owner, members: new Set(g.members) })
}
console.log(`restored ${known.size} users, ${groups.size} groups`)

// ------------------------------------------------------------------
// Presence notification (respects online_privacy)
// ------------------------------------------------------------------

const notifyPresence = async (userId, onlineState, lastSeen) => {
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

// ------------------------------------------------------------------
// Group helpers
// ------------------------------------------------------------------

const groupInfo = (id) => {
  const g = groups.get(id)
  const nameOf = (m) => online.get(m)?.name ?? known.get(m)?.name ?? 'unknown'
  return { id, name: g.name, owner: g.owner, members: [...g.members].map((m) => ({ id: m, name: nameOf(m) })) }
}

const emitToMembers = (groupId, event, data, exceptId) => {
  const g = groups.get(groupId)
  if (!g) return
  for (const m of g.members) {
    if (m === exceptId) continue
    const u = online.get(m)
    if (u) io.to(u.socketId).emit(event, data)
  }
}

// ------------------------------------------------------------------
// Socket connection
// ------------------------------------------------------------------

io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
             || socket.handshake.address
  const ua = socket.handshake.headers['user-agent'] || ''
  const deviceHint = parseDeviceHint(ua)

  const getContactsWithPresence = async (userId) => {
    const contacts = await store.getContacts(userId)
    return contacts.map(c => {
      const peerId = c.requester_id === userId ? c.recipient_id : c.requester_id
      return { ...c, online: online.has(peerId) }
    })
  }

  // Resolve relationship: returns contact row or null
  const getContact = async (fromId, toId) => {
    const contacts = await store.getContacts(fromId)
    return contacts.find(c =>
      (c.requester_id === fromId && c.recipient_id === toId) ||
      (c.recipient_id === fromId && c.requester_id === toId)
    ) || null
  }

  // ---- hello (auth + session creation) ----
  socket.on('hello', async ({ id, name, username, pubKey }) => {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || !pubKey) return
    const cleanName = name.trim().slice(0, 32)
    const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 32) : `user_${id.slice(0, 6)}`

    const isAvailable = await store.checkUsernameAvailable(cleanUsername, id)
    if (!isAvailable) {
      socket.emit('auth-error', 'Username is already taken')
      return
    }

    // One active session per identity
    const prev = online.get(id)
    if (prev && prev.socketId !== socket.id) {
      const old = io.sockets.sockets.get(prev.socketId)
      old?.emit('session-replaced')
      old?.disconnect(true)
      // Revoke the old session
      if (prev.sessionId) store.revokeSession(prev.sessionId, id)
    }

    // Create a new session record
    const sessionId = randomUUID()
    socket.data.clientId = id
    socket.data.sessionId = sessionId
    store.createSession(sessionId, id, socket.id, ip, ua, deviceHint)

    online.set(id, { socketId: socket.id, name: cleanName, username: cleanUsername, pubKey, sessionId })
    known.set(id, { name: cleanName, username: cleanUsername, pubKey, lastSeen: Date.now() })
    store.upsertUser(id, cleanName, JSON.stringify(pubKey), cleanUsername)

    // Warm privacy cache
    const privacy = await store.getPrivacySettings(id)
    privacyCache.set(id, privacy)

    const contacts = await getContactsWithPresence(id)
    socket.emit('contacts', contacts)
    notifyPresence(id, true, Date.now())

    for (const [gid, g] of groups) {
      if (g.members.has(id)) socket.emit('group-added', groupInfo(gid))
    }

    const rows = await store.backlog(id)
    const undelivered = await store.undeliveredSenders(id)
    socket.emit('backlog', rows.map((r) => ({
      id: r.id,
      from: r.sender,
      fromName: known.get(r.sender)?.name ?? 'unknown',
      senderPub: JSON.parse(r.sender_pub),
      groupId: r.group_id,
      payload: JSON.parse(r.payload),
      ts: Number(r.ts),
    })))
    for (const row of undelivered) {
      store.markDelivered(row.id, id)
      const sender = online.get(row.sender)
      if (sender) io.to(sender.socketId).emit('delivered', { from: id, msgId: row.id })
    }

    const myProfile = await store.getUser(id)
    if (myProfile) socket.emit('profile', myProfile)

    // Send privacy settings + notification prefs
    socket.emit('privacy-settings', privacy)
    const notifPrefs = await store.getNotificationPrefs(id)
    socket.emit('notification-prefs', notifPrefs)
  })

  const clientId = () => socket.data.clientId
  const myPub = () => JSON.stringify(online.get(clientId())?.pubKey ?? null)

  // ---- contacts ----

  socket.on('contact-request', async ({ to }) => {
    const from = clientId()
    if (!from || !to || from === to) return

    // Check if already blocked
    const existing = await store.getContacts(from)
    const rel = existing.find(c => c.requester_id === to || c.recipient_id === to)
    if (rel && rel.status === 'blocked') return

    // Respect target's message_privacy: if 'nobody', can't be messaged/contacted
    const targetPrivacy = privacyCache.get(to) || await store.getPrivacySettings(to)
    const isContact = rel?.status === 'accepted'
    if (!privacyAllows(targetPrivacy?.message_privacy ?? 'everyone', isContact)) return

    await store.upsertContact(from, to, 'pending')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
  })

  socket.on('contact-accept', async ({ to }) => {
    const from = clientId()
    if (!from || !to) return
    await store.upsertContact(to, from, 'accepted')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
    notifyPresence(from, true, Date.now())
  })

  socket.on('contact-reject', async ({ to }) => {
    const from = clientId()
    if (!from || !to) return
    await store.upsertContact(to, from, 'rejected')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
  })

  socket.on('contact-remove', async ({ to }) => {
    const from = clientId()
    if (!from || !to) return
    await store.deleteContact(from, to)
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
  })

  socket.on('contact-block', async ({ to }) => {
    const from = clientId()
    if (!from || !to) return
    await store.upsertContact(from, to, 'blocked')
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
  })

  socket.on('contact-unblock', async ({ to }) => {
    const from = clientId()
    if (!from || !to) return
    await store.deleteContact(from, to)
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('contact-updated', await getContactsWithPresence(to))
    socket.emit('contact-updated', await getContactsWithPresence(from))
  })

  // ---- profile ----

  socket.on('update-profile', async ({ name, username, bio, avatar }) => {
    const from = clientId()
    if (!from) return
    if (username) {
      const cleanUsername = username.trim().toLowerCase().slice(0, 32)
      const isAvailable = await store.checkUsernameAvailable(cleanUsername, from)
      if (!isAvailable) { socket.emit('profile-error', 'Username is already taken'); return }
      username = cleanUsername
    }
    const cleanName = name ? name.trim().slice(0, 32) : online.get(from)?.name
    await store.updateProfile(from, { name: cleanName, username, bio: bio ? bio.trim().slice(0, 160) : '', avatar })
    if (online.has(from)) {
      online.get(from).name = cleanName
      if (username) online.get(from).username = username
    }
    socket.emit('profile-updated', await store.getUser(from))
  })

  // ---- invitations ----

  socket.on('create-invite', async (options) => {
    const from = clientId()
    if (!from) return
    const code = randomUUID().split('-')[0]
    const expiresAt = options?.expiresIn ? Date.now() + options.expiresIn : null
    store.createInvite(randomUUID(), code, from, expiresAt)
    socket.emit('invite-created', { code, expiresAt })
  })

  socket.on('get-invite', async ({ code }, callback) => {
    if (!code || typeof callback !== 'function') return
    const invite = await store.getInvite(code)
    if (!invite) return callback({ error: 'Invite not found' })
    if (invite.expires_at && invite.expires_at < Date.now()) return callback({ error: 'Invite expired' })
    callback({ invite })
  })

  // ---- privacy settings ----

  socket.on('get-privacy-settings', async (callback) => {
    const from = clientId()
    if (!from) return
    const settings = await store.getPrivacySettings(from)
    privacyCache.set(from, settings)
    if (typeof callback === 'function') callback(settings)
    else socket.emit('privacy-settings', settings)
  })

  socket.on('save-privacy-settings', async (settings) => {
    const from = clientId()
    if (!from) return
    const valid = ['everyone', 'contacts', 'nobody']
    const cleaned = {
      message_privacy:   valid.includes(settings.message_privacy)   ? settings.message_privacy   : 'everyone',
      call_privacy:      valid.includes(settings.call_privacy)      ? settings.call_privacy      : 'everyone',
      last_seen_privacy: valid.includes(settings.last_seen_privacy) ? settings.last_seen_privacy : 'everyone',
      online_privacy:    valid.includes(settings.online_privacy)    ? settings.online_privacy    : 'everyone',
      avatar_privacy:    valid.includes(settings.avatar_privacy)    ? settings.avatar_privacy    : 'everyone',
      bio_privacy:       valid.includes(settings.bio_privacy)       ? settings.bio_privacy       : 'everyone',
    }
    await store.savePrivacySettings(from, cleaned)
    privacyCache.set(from, { user_id: from, ...cleaned })
    socket.emit('privacy-settings', { user_id: from, ...cleaned })
  })

  // ---- reporting ----

  socket.on('report-user', async ({ reportedId, category, details }) => {
    const from = clientId()
    if (!from || !reportedId || from === reportedId) return
    const validCategories = ['spam', 'harassment', 'fake_account', 'inappropriate_content', 'scam', 'other']
    if (!validCategories.includes(category)) return
    store.createReport(randomUUID(), from, reportedId, category, details?.slice(0, 500) || null)
    socket.emit('report-sent', { ok: true })
  })

  // ---- notification preferences ----

  socket.on('get-notification-prefs', async (callback) => {
    const from = clientId()
    if (!from) return
    const prefs = await store.getNotificationPrefs(from)
    if (typeof callback === 'function') callback(prefs)
    else socket.emit('notification-prefs', prefs)
  })

  socket.on('save-notification-prefs', async (prefs) => {
    const from = clientId()
    if (!from) return
    await store.saveNotificationPrefs(from, {
      messages:         prefs.messages         !== false,
      calls:            prefs.calls            !== false,
      contact_requests: prefs.contact_requests !== false,
      mentions:         prefs.mentions         !== false,
    })
    socket.emit('notification-prefs', await store.getNotificationPrefs(from))
  })

  // ---- sessions ----

  socket.on('get-sessions', async (callback) => {
    const from = clientId()
    if (!from) return
    const sessions = await store.getSessions(from)
    const currentSessionId = socket.data.sessionId
    const result = sessions.map(s => ({ ...s, isCurrent: s.id === currentSessionId }))
    if (typeof callback === 'function') callback(result)
    else socket.emit('sessions', result)
  })

  socket.on('revoke-session', async ({ sessionId }) => {
    const from = clientId()
    if (!from || !sessionId) return
    // Can't revoke your own current session this way (use sign-out for that)
    if (sessionId === socket.data.sessionId) return
    await store.revokeSession(sessionId, from)
    // Kick that socket if it's still connected
    for (const [_, s] of io.sockets.sockets) {
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
    await store.revokeAllSessionsExcept(from, socket.data.sessionId)
    // Kick all other sockets for this user
    for (const [_, s] of io.sockets.sockets) {
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

  // ---- message delivery (with privacy enforcement) ----

  const route = (event) => async (msg) => {
    const from = clientId()
    const target = from && msg && online.get(msg.to)
    if (!target) return
    const contact = await getContact(from, msg.to)
    if (!contact || contact.status !== 'accepted') return
    io.to(target.socketId).emit(event, { ...msg, from, fromName: online.get(from)?.name })
  }

  socket.on('typing', route('typing'))
  for (const ev of ['call-answer', 'call-ice', 'call-end', 'call-decline', 'share-state', 'cam-state', 'mic-state']) {
    socket.on(ev, route(ev))
  }

  // call-offer: enforce call_privacy
  socket.on('call-offer', async (msg) => {
    const from = clientId()
    if (!from || !msg?.to) return
    const target = online.get(msg.to)
    if (!target) return
    const contact = await getContact(from, msg.to)
    if (!contact || contact.status !== 'accepted') return

    // Respect the callee's call_privacy setting
    const targetPrivacy = privacyCache.get(msg.to) || await store.getPrivacySettings(msg.to)
    const isContact = contact?.status === 'accepted'
    if (!privacyAllows(targetPrivacy?.call_privacy ?? 'everyone', isContact)) {
      socket.emit('call-declined', { from: msg.to, reason: 'privacy' })
      return
    }
    io.to(target.socketId).emit('call-offer', { ...msg, from, fromName: online.get(from)?.name })
  })

  // dm: enforce message_privacy + contact status
  socket.on('dm', async ({ to, id, payload, selfPayload, ts }) => {
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
    if (known.has(to) || wasRouted) {
      store.saveMessage(id, to, from, myPub(), null, JSON.stringify(payload), ts, false)
    }
    if (selfPayload) store.saveMessage(id, from, from, myPub(), null, JSON.stringify(selfPayload), ts, true)
  })

  socket.on('delivered', ({ to, msgId }) => {
    const from = clientId()
    if (!from || !to) return
    store.markDelivered(msgId, from)
    const target = online.get(to)
    if (target) io.to(target.socketId).emit('delivered', { from, msgId })
  })

  // ---- groups ----

  socket.on('group-create', ({ name, members }) => {
    const from = clientId()
    if (!from || typeof name !== 'string' || !name.trim() || !Array.isArray(members)) return
    const id = `g-${randomUUID()}`
    const all = new Set([from, ...members.filter((m) => known.has(m) || online.has(m))])
    if (all.size < 2) return
    groups.set(id, { name: name.trim().slice(0, 48), owner: from, members: all })
    store.saveGroup(id, name.trim().slice(0, 48), from, [...all])
    emitToMembers(id, 'group-added', groupInfo(id))
  })

  socket.on('group-delete', ({ groupId }) => {
    const g = groups.get(groupId)
    if (!g || g.owner !== clientId()) return
    emitToMembers(groupId, 'group-removed', { id: groupId, by: online.get(clientId())?.name })
    groups.delete(groupId)
    store.deleteGroup(groupId)
  })

  socket.on('group-leave', ({ groupId }) => {
    const g = groups.get(groupId)
    const from = clientId()
    if (!g || !g.members.has(from)) return
    emitToMembers(groupId, 'group-left', { id: groupId, memberId: from, name: online.get(from)?.name })
    g.members.delete(from)
    if (g.members.size < 2) {
      emitToMembers(groupId, 'group-removed', { id: groupId })
      groups.delete(groupId)
      store.deleteGroup(groupId)
    } else {
      if (g.owner === from) g.owner = [...g.members][0]
      store.saveGroup(groupId, g.name, g.owner, [...g.members])
      emitToMembers(groupId, 'group-added', groupInfo(groupId))
    }
  })

  socket.on('group-invite', ({ groupId, members }) => {
    const g = groups.get(groupId)
    const from = clientId()
    if (!g || !g.members.has(from) || !Array.isArray(members)) return
    const added = members.filter((m) => (known.has(m) || online.has(m)) && !g.members.has(m))
    if (!added.length) return
    added.forEach((m) => g.members.add(m))
    store.saveGroup(groupId, g.name, g.owner, [...g.members])
    const names = added.map((m) => online.get(m)?.name ?? known.get(m)?.name).join(', ')
    emitToMembers(groupId, 'group-added', groupInfo(groupId))
    for (const m of g.members) {
      if (added.includes(m)) continue
      const u = online.get(m)
      if (u) io.to(u.socketId).emit('group-joined', { id: groupId, names })
    }
  })

  socket.on('gdm', ({ groupId, id, payloads, ts }) => {
    const from = clientId()
    const g = groups.get(groupId)
    if (!from || !g || !g.members.has(from) || !payloads) return
    for (const [memberId, payload] of Object.entries(payloads)) {
      if (!g.members.has(memberId)) continue
      if (memberId === from) {
        store.saveMessage(id, from, from, myPub(), groupId, JSON.stringify(payload), ts, true)
        continue
      }
      const u = online.get(memberId)
      if (u) io.to(u.socketId).emit('gdm', { groupId, from, fromName: online.get(from)?.name, id, payload, ts })
      store.saveMessage(id, memberId, from, myPub(), groupId, JSON.stringify(payload), ts, !!u)
    }
  })

  socket.on('gtyping', ({ groupId }) => {
    const from = clientId()
    if (!groups.get(groupId)?.members.has(from)) return
    emitToMembers(groupId, 'gtyping', { groupId, from, name: online.get(from)?.name }, from)
  })

  for (const ev of ['gcall-ring', 'gcall-join', 'gcall-leave']) {
    socket.on(ev, ({ groupId, to }) => {
      const from = clientId()
      const g = groups.get(groupId)
      if (!g?.members.has(from)) return
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

  // ---- disconnect ----

  socket.on('disconnect', () => {
    const id = clientId()
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
})

httpServer.listen(PORT, '0.0.0.0', () => console.log(`sable relay listening on :${PORT}`))
