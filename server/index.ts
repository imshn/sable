// Sable relay server — routes ciphertext, public keys, and WebRTC signaling.
// With Turso configured it also persists ciphertext history and offline
// deliveries; the server still cannot read any message content.
//
// Bootstrap only: build the Express app + Socket.IO server, restore
// in-memory state from the DB, and wire each domain module's handlers onto
// every new connection. The actual route/event logic lives in http.ts and
// sockets/*.ts.
import { createServer } from 'node:http'
import { migrate, store } from './db.js'
import { createHttpApp } from './http.js'
import { initIo } from './io.js'
import { known, groups } from './state.js'
import { registerPresence } from './sockets/presence.js'
import { registerContacts } from './sockets/contacts.js'
import { registerGroups } from './sockets/groups.js'
import { registerMessages } from './sockets/messages.js'
import { registerCalls } from './sockets/calls.js'
import { registerSettings } from './sockets/settings.js'
import type { AppSocket } from './types.js'

const PORT = Number(process.env.PORT) || 3001

process.on('uncaughtException', (e) => console.error('uncaughtException', e))
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e))

const httpServer = createServer(createHttpApp())
const io = initIo(httpServer)

await migrate()
for (const u of await store.allUsers()) {
  known.set(u.id, { name: u.name, username: u.username, pubKey: JSON.parse(u.pubkey), lastSeen: Number(u.last_seen) })
}
for (const g of await store.loadGroups()) {
  groups.set(g.id, { name: g.name, owner: g.owner, members: new Set(g.members) })
}
console.log(`restored ${known.size} users, ${groups.size} groups`)

io.on('connection', (socket: AppSocket) => {
  const ctx = registerPresence(socket)
  registerContacts(socket, ctx)
  registerGroups(socket, ctx)
  registerMessages(socket, ctx)
  registerCalls(socket, ctx)
  registerSettings(socket, ctx)
})

httpServer.listen(PORT, '0.0.0.0', () => console.log(`sable relay listening on :${PORT}`))
