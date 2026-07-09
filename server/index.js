// Sable relay server — routes ciphertext, public keys, and WebRTC signaling only.
// Plaintext never touches this process. Users and groups live in memory; nothing persists.
// The one exception to blindness: /preview fetches OG tags for link cards, so the
// relay sees previewed URLs (same tradeoff WhatsApp makes for link previews).
import { Server } from 'socket.io'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

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

const httpServer = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://relay')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (u.pathname === '/healthz') {
    res.writeHead(200)
    return res.end('ok')
  }
  if (u.pathname !== '/preview') {
    res.writeHead(404)
    return res.end()
  }
  res.setHeader('Content-Type', 'application/json')
  try {
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

const users = new Map() // clientId -> { socketId, name, pubKey }
const groups = new Map() // groupId -> { name, owner, members: Set<clientId> }

const directory = () =>
  [...users.entries()].map(([id, u]) => ({ id, name: u.name, pubKey: u.pubKey }))

const groupInfo = (id) => {
  const g = groups.get(id)
  return {
    id,
    name: g.name,
    owner: g.owner,
    members: [...g.members].map((m) => ({ id: m, name: users.get(m)?.name ?? 'unknown' })),
  }
}

const emitToMembers = (groupId, event, data, exceptId) => {
  const g = groups.get(groupId)
  if (!g) return
  for (const m of g.members) {
    if (m === exceptId) continue
    const u = users.get(m)
    if (u) io.to(u.socketId).emit(event, data)
  }
}

io.on('connection', (socket) => {
  socket.on('hello', ({ id, name, pubKey }) => {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || !pubKey) return
    socket.data.clientId = id
    users.set(id, { socketId: socket.id, name: name.trim().slice(0, 32), pubKey })
    io.emit('directory', directory())
    // re-sync group memberships after a reload
    for (const [gid, g] of groups) {
      if (g.members.has(id)) socket.emit('group-added', groupInfo(gid))
    }
  })

  const clientId = () => socket.data.clientId

  // ----- direct routing -----
  const route = (event) => (msg) => {
    const from = clientId()
    const target = from && msg && users.get(msg.to)
    if (!target) return
    io.to(target.socketId).emit(event, { ...msg, from, fromName: users.get(from)?.name })
  }

  socket.on('dm', route('dm'))
  socket.on('typing', route('typing'))
  socket.on('delivered', route('delivered'))
  for (const ev of ['call-offer', 'call-answer', 'call-ice', 'call-end', 'call-decline', 'share-state']) {
    socket.on(ev, route(ev))
  }

  // ----- groups -----
  socket.on('group-create', ({ name, members }) => {
    const from = clientId()
    if (!from || typeof name !== 'string' || !name.trim() || !Array.isArray(members)) return
    const id = `g-${randomUUID()}`
    const all = new Set([from, ...members.filter((m) => users.has(m))])
    if (all.size < 2) return
    groups.set(id, { name: name.trim().slice(0, 48), owner: from, members: all })
    emitToMembers(id, 'group-added', groupInfo(id))
  })

  socket.on('group-delete', ({ groupId }) => {
    const g = groups.get(groupId)
    if (!g || g.owner !== clientId()) return
    emitToMembers(groupId, 'group-removed', { id: groupId, by: users.get(clientId())?.name })
    groups.delete(groupId)
  })

  socket.on('group-leave', ({ groupId }) => {
    const g = groups.get(groupId)
    const from = clientId()
    if (!g || !g.members.has(from)) return
    emitToMembers(groupId, 'group-left', { id: groupId, memberId: from, name: users.get(from)?.name })
    g.members.delete(from)
    if (g.members.size < 2) {
      emitToMembers(groupId, 'group-removed', { id: groupId })
      groups.delete(groupId)
    } else {
      if (g.owner === from) g.owner = [...g.members][0]
      emitToMembers(groupId, 'group-added', groupInfo(groupId)) // resync roster
    }
  })

  // group message: payloads = { [memberId]: { iv, ct } }, one ciphertext per member
  socket.on('gdm', ({ groupId, id, payloads, ts }) => {
    const from = clientId()
    const g = groups.get(groupId)
    if (!from || !g || !g.members.has(from) || !payloads) return
    for (const [memberId, payload] of Object.entries(payloads)) {
      if (!g.members.has(memberId) || memberId === from) continue
      const u = users.get(memberId)
      if (u) io.to(u.socketId).emit('gdm', { groupId, from, fromName: users.get(from)?.name, id, payload, ts })
    }
  })

  socket.on('gtyping', ({ groupId }) => {
    const from = clientId()
    if (!groups.get(groupId)?.members.has(from)) return
    emitToMembers(groupId, 'gtyping', { groupId, from, name: users.get(from)?.name }, from)
  })

  socket.on('group-invite', ({ groupId, members }) => {
    const g = groups.get(groupId)
    const from = clientId()
    if (!g || !g.members.has(from) || !Array.isArray(members)) return
    const added = members.filter((m) => users.has(m) && !g.members.has(m))
    if (!added.length) return
    added.forEach((m) => g.members.add(m))
    const names = added.map((m) => users.get(m)?.name).join(', ')
    emitToMembers(groupId, 'group-added', groupInfo(groupId))
    for (const m of g.members) {
      if (added.includes(m)) continue
      const u = users.get(m)
      if (u) io.to(u.socketId).emit('group-joined', { id: groupId, names })
    }
  })

  // group calls: ring + mesh membership announcements; offers/ice go via direct routes.
  // gcall-ring accepts an optional `to` for targeted invites into an ongoing call.
  for (const ev of ['gcall-ring', 'gcall-join', 'gcall-leave']) {
    socket.on(ev, ({ groupId, to }) => {
      const from = clientId()
      const g = groups.get(groupId)
      if (!g?.members.has(from)) return
      const data = { groupId, from, name: users.get(from)?.name }
      if (ev === 'gcall-ring' && to) {
        if (!g.members.has(to)) return
        const u = users.get(to)
        if (u) io.to(u.socketId).emit(ev, data)
        return
      }
      emitToMembers(groupId, ev, data, from)
    })
  }

  socket.on('disconnect', () => {
    const id = clientId()
    if (id && users.get(id)?.socketId === socket.id) {
      users.delete(id)
      io.emit('directory', directory())
    }
  })
})

httpServer.listen(PORT, () => console.log(`sable relay listening on :${PORT}`))
