// The boundary layer: every inbound socket packet passes through
// packetGuard (rate limit + burst + Zod shape validation), every handler
// exception funnels through wrapSocketErrors, and the HTTP side gets the
// matching httpLimit middleware + centralized errorHandler.
//
// Validation philosophy: loose schemas that reject garbage (wrong types,
// absurd sizes) without pinning every optional field — handlers keep their
// own domain checks (contact status, privacy, flags). The boundary stops
// abuse; the handler enforces business rules.
import { z } from 'zod'
import type { Request, Response, NextFunction } from 'express'
import { allow } from './rateLimit.js'
import { log } from './log.js'
import type { AppSocket } from './types.js'

const id = z.string().min(1).max(200)
const encrypted = z.looseObject({ iv: z.string().max(200), ct: z.string() })

// Only events worth guarding get schemas — pure reads with no args
// (get-sessions, get-passkeys, ...) have nothing to validate.
const SCHEMAS: Record<string, z.ZodType> = {
  hello: z.looseObject({ id, name: z.string().min(1).max(100), username: z.string().max(100).optional(), pubKey: z.record(z.string(), z.unknown()) }),
  dm: z.looseObject({ to: id, id, payload: encrypted, selfPayload: encrypted.optional(), ts: z.number() }),
  gdm: z.looseObject({ groupId: id, id, payloads: z.record(z.string(), z.unknown()), ts: z.number(), mentions: z.array(id).max(100).optional() }),
  'call-offer': z.looseObject({ to: id }),
  'contact-request': z.looseObject({ to: id }),
  'group-create': z.looseObject({ name: z.string().min(1).max(64), members: z.array(id).max(100) }),
  'report-user': z.looseObject({ reportedId: id, category: z.string().max(40), details: z.string().max(2000).optional() }),
  'update-profile': z.looseObject({
    name: z.string().max(100).optional(), username: z.string().max(100).optional(),
    bio: z.string().max(500).optional(), avatar: z.string().max(500_000).optional(),
  }),
  'set-contact-nickname': z.looseObject({ contactId: id, nickname: z.string().max(100).nullable().optional() }),
}

// Per-packet middleware: rate limit first (cheapest), then shape-check.
// A rejected packet is dropped (handler never runs) and the client gets a
// standard event it can surface — real users on the generous limits never
// see it; floods just go quiet.
export function packetGuard(socket: AppSocket, ip: string): void {
  socket.use(async (event, next) => {
    const name = String(event[0])
    const who = socket.data.clientId ?? ip

    if (!(await allow(name, who))) {
      log.security.warn({ event: name, who }, 'rate limited')
      socket.emit('rate-limited', { event: name })
      return // drop, don't next()
    }

    const schema = SCHEMAS[name]
    if (schema) {
      const result = schema.safeParse(event[1])
      if (!result.success) {
        log.socket.warn({ event: name, who, issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.code}`) }, 'invalid payload')
        socket.emit('invalid-request', { event: name })
        return
      }
    }
    next()
  })
}

// Centralized socket error handling: patches socket.on so every listener —
// sync or async — reports failures to one place instead of dying as an
// unhandledRejection. Zero changes needed in the six domain modules.
export function wrapSocketErrors(socket: AppSocket): void {
  const origOn = socket.on.bind(socket)
  socket.on = ((event: string, listener: (...args: unknown[]) => unknown) =>
    origOn(event, (...args: unknown[]) => {
      try {
        const r = listener(...args)
        if (r instanceof Promise) {
          r.catch((e) => log.socket.error({ event, clientId: socket.data.clientId, err: e instanceof Error ? e.message : String(e) }, 'handler error'))
        }
      } catch (e) {
        log.socket.error({ event, clientId: socket.data.clientId, err: e instanceof Error ? e.message : String(e) }, 'handler error')
      }
    })) as typeof socket.on
}

// HTTP twin of packetGuard for the few public GET endpoints.
export function httpLimit(rule: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (await allow(rule, req.ip ?? '?')) { next(); return }
    log.security.warn({ rule, ip: req.ip }, 'http rate limited')
    res.status(429).json({ error: 'Too many requests' })
  }
}

// Final Express error middleware — one place, one shape, internals never
// leak (Express 5 forwards rejected async handlers here automatically).
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  log.api.error({ path: req.path, err: err instanceof Error ? err.message : String(err) }, 'request failed')
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
}
