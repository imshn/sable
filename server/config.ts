// Typed, validated environment configuration — the single place env vars are
// read. Everything else imports `env` from here instead of touching
// process.env, so a malformed value fails loudly at boot with a precise
// message instead of surfacing later as a confusing runtime bug.
//
// Philosophy: features degrade gracefully when *absent* (no Turso = memory
// only, no push keys = push disabled — matching how the app has always
// behaved), but fail fast when *malformed* or half-configured, because a
// typo'd URL or one key of a pair is always a mistake, never a choice.
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.string().default('development'),

  TURSO_DATABASE_URL: z.url().optional(),
  TURSO_AUTH_TOKEN: z.string().min(1).optional(),

  ADMIN_SECRET: z.string().min(16, 'ADMIN_SECRET must be at least 16 chars').optional(),

  WEB_PUSH_PUBLIC_KEY: z.string().min(1).optional(),
  WEB_PUSH_PRIVATE_KEY: z.string().min(1).optional(),
  WEB_PUSH_CONTACT: z.string().default('mailto:admin@example.com'),

  CF_TURN_KEY_ID: z.string().min(1).optional(),
  CF_TURN_API_TOKEN: z.string().min(1).optional(),

  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_ORIGIN: z.string().default('http://localhost:5173'),

  // Comma-separated CORS allowlist. Entries may be exact origins or a
  // leading-* wildcard subdomain pattern like https://*.vercel.app.
  CORS_ORIGINS: z.string().default('https://sable-chat.vercel.app,https://sable-chat-*-mohammed-shahnawazs-projects.vercel.app,http://localhost:5173,http://localhost:4173'),

  // Batch 2: presence of a Redis URL is what switches on the Redis-backed
  // rate-limit store, cache layer, Socket.IO adapter, and BullMQ queues.
  REDIS_URL: z.url().optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

// Pairs where having one half but not the other is always a config mistake.
const PAIRS: Array<[keyof z.infer<typeof schema>, keyof z.infer<typeof schema>]> = [
  ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
  ['WEB_PUSH_PUBLIC_KEY', 'WEB_PUSH_PRIVATE_KEY'],
  ['CF_TURN_KEY_ID', 'CF_TURN_API_TOKEN'],
]

function load(): z.infer<typeof schema> {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    console.error(`Invalid environment configuration:\n${lines.join('\n')}`)
    process.exit(1)
  }
  for (const [a, b] of PAIRS) {
    if (!!parsed.data[a] !== !!parsed.data[b]) {
      console.error(`Invalid environment configuration:\n  ${a} and ${b} must be set together (only one is present)`)
      process.exit(1)
    }
  }
  return parsed.data
}

export const env = load()

export const isProd = env.NODE_ENV === 'production' || !!process.env.RENDER

// Origin checker shared by Express CORS and Socket.IO CORS.
const corsPatterns = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true // same-origin / curl / server-to-server
  return corsPatterns.some((p) =>
    p.includes('*')
      ? new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i').test(origin)
      : p === origin
  )
}
