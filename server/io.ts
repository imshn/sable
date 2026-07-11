// The single Socket.IO server instance, created once in index.ts's bootstrap
// after the underlying http.Server exists. Exported as a live ES module
// binding so modules that need it (notify.ts, helpers.ts) can import it
// before it's initialized and still see the real instance once it is —
// avoids a circular-import deadlock between the HTTP routes (which need
// broadcastAnnouncement) and the notifier (which needs `io` to emit).
import { Server } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import { originAllowed } from './config.js'

export let io: Server

export function initIo(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, originAllowed(origin)) },
    maxHttpBufferSize: 40e6,
  })
  return io
}
