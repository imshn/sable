// Sable relay server — routes ciphertext, public keys, and WebRTC signaling.
// With Turso configured it also persists ciphertext history and offline
// deliveries; the server still cannot read any message content.
// The one exception to blindness: /preview fetches OG tags for link cards.
import { Server } from 'socket.io'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { migrate, store } from './db.js'

const PORT = process.env.PORT || 3001

const metaTags = (html) => {
  const tags = {}
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0]
    const key = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase()
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1]
    if (key && content && !tags[key]) tags[key] = content
  }
  return tags
}

const decodeEntities = (s) =>
  s?.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" })[m])

// Cloudflare Realtime TURN: mint short-lived credentials server-side so the
// long-lived API token never reaches a browser. Credentials live 2h; we cache
// them for 1h so clients always receive at least an hour of validity.
// https://developers.cloudflare.com/realtime/turn/generate-credentials/
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
          headers: {
            Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 7200 }),
          signal: AbortSignal.timeout(6000),
        }
      )
      const body = await r.json()
      if (r.ok && Array.isArray(body.iceServers)) servers = body.iceServers
      else console.error('cloudflare turn mint failed', r.status, JSON.stringify(body).slice(0, 200))
    }
  } catch (e) {
    console.error('turn fetch failed', e.message)
  }
  // don't sit on an empty answer — retry in a minute
  turnCache = { at: servers.length ? Date.now() : Date.now() - 3540_000, servers }
  return servers
}

// a crashed relay takes every conversation down with it — never die on a bad request
const BOOT_ID = randomUUID().slice(0, 8)
process.on('uncaughtException', (e) => console.error('uncaughtException', e))
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e))

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
  maxHttpBufferSize: 40e6, // encrypted file payloads (15MB file ≈ 28MB b64+json)
})

// presence + latest keys live in memory; Turso remembers everyone across restarts
const online = new Map() // clientId -> { socketId, name, pubKey }
const known = new Map() // clientId -> { name, pubKey, lastSeen } (persisted users)
const groups = new Map() // groupId -> { name, owner, members: Set<clientId> }

await migrate()
for (const u of await store.allUsers()) {
  known.set(u.id, { name: u.name, pubKey: JSON.parse(u.pubkey), lastSeen: Number(u.last_seen) })
}
for (const g of await store.loadGroups()) {
  groups.set(g.id, { name: g.name, owner: g.owner, members: new Set(g.members) })
}
console.log(`restored ${known.size} users, ${groups.size} groups`)

const directory = () => {
  const list = []
  for (const [id, u] of known) {
    list.push({ id, name: u.name, pubKey: u.pubKey, online: online.has(id), lastSeen: u.lastSeen })
  }
  for (const [id, u] of online) {
    if (!known.has(id)) list.push({ id, name: u.name, pubKey: u.pubKey, online: true, lastSeen: Date.now() })
  }
  return list
}

const broadcastDirectory = () => io.emit('directory', directory())

const groupInfo = (id) => {
  const g = groups.get(id)
  const nameOf = (m) => online.get(m)?.name ?? known.get(m)?.name ?? 'unknown'
  return {
    id,
    name: g.name,
    owner: g.owner,
    members: [...g.members].map((m) => ({ id: m, name: nameOf(m) })),
  }
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

io.on('connection', (socket) => {
  socket.on('hello', async ({ id, name, pubKey }) => {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || !pubKey) return
    const cleanName = name.trim().slice(0, 32)
    // one active session per identity: a fresh sign-in replaces the old tab
    const prev = online.get(id)
    if (prev && prev.socketId !== socket.id) {
      const old = io.sockets.sockets.get(prev.socketId)
      old?.emit('session-replaced')
      old?.disconnect(true)
    }
    socket.data.clientId = id
    online.set(id, { socketId: socket.id, name: cleanName, pubKey })
    known.set(id, { name: cleanName, pubKey, lastSeen: Date.now() })
    store.upsertUser(id, cleanName, JSON.stringify(pubKey))
    broadcastDirectory()

    for (const [gid, g] of groups) {
      if (g.members.has(id)) socket.emit('group-added', groupInfo(gid))
    }

    // ciphertext history + anything that arrived while offline
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
  })

  const clientId = () => socket.data.clientId
  const myPub = () => JSON.stringify(online.get(clientId())?.pubKey ?? null)

  // ----- direct routing -----
  const route = (event) => (msg) => {
    const from = clientId()
    const target = from && msg && online.get(msg.to)
    if (!target) return
    io.to(target.socketId).emit(event, { ...msg, from, fromName: online.get(from)?.name })
  }

  socket.on('typing', route('typing'))
  for (const ev of ['call-offer', 'call-answer', 'call-ice', 'call-end', 'call-decline', 'share-state', 'cam-state']) {
    socket.on(ev, route(ev))
  }

  // dm: { to, id, payload, selfPayload?, ts } — payload sealed for the
  // recipient, selfPayload sealed for the sender (their own history copy)
  socket.on('dm', ({ to, id, payload, selfPayload, ts }) => {
    const from = clientId()
    if (!from || !to || !payload) return
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

  // ----- groups -----
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

  // gdm payloads: { [memberId]: { iv, ct } } — may include the sender's own
  // history copy, which is stored but never routed
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

  // group calls: ring + mesh membership announcements; offers/ice go via direct routes.
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

  socket.on('disconnect', () => {
    const id = clientId()
    if (id && online.get(id)?.socketId === socket.id) {
      online.delete(id)
      const k = known.get(id)
      if (k) k.lastSeen = Date.now()
      store.touchUser(id)
      broadcastDirectory()
    }
  })
})

httpServer.listen(PORT, '0.0.0.0', () => console.log(`sable relay listening on :${PORT}`))
