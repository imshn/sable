import { io } from './io.js'
import { env } from './config.js'
import { online, known, groups } from './state.js'
import type { PrivacyLevel } from './types.js'

// ---- OG-preview scraping helpers ----

export const metaTags = (html: string): Record<string, string> => {
  const tags: Record<string, string> = {}
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0]
    const key = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase()
    const content = tag.match(/content=["']([^"']*)["|']/i)?.[1]
    if (key && content && !tags[key]) tags[key] = content
  }
  return tags
}

const ENTITY_MAP: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" }
export const decodeEntities = (s: string | undefined): string | undefined =>
  s?.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITY_MAP[m])

// ---- TURN server credentials (Cloudflare Realtime) ----

interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

let turnCache: { at: number; servers: IceServer[] } = { at: 0, servers: [] }
export async function turnServers(): Promise<IceServer[]> {
  if (Date.now() - turnCache.at < 3600_000) return turnCache.servers
  let servers: IceServer[] = []
  try {
    if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 7200 }),
          signal: AbortSignal.timeout(6000),
        }
      )
      const body = await r.json() as { iceServers?: IceServer[] }
      if (r.ok && Array.isArray(body.iceServers)) servers = body.iceServers
      else console.error('cloudflare turn mint failed', r.status, JSON.stringify(body).slice(0, 200))
    }
  } catch (e) { console.error('turn fetch failed', (e as Error).message) }
  turnCache = { at: servers.length ? Date.now() : Date.now() - 3540_000, servers }
  return servers
}

// ---- misc ----

// Parse a User-Agent string into a human-readable device hint
export function parseDeviceHint(ua = ''): string {
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
export function privacyAllows(setting: PrivacyLevel, isContact: boolean): boolean {
  if (setting === 'everyone') return true
  if (setting === 'contacts') return isContact
  return false // 'nobody'
}

// ---- Group helpers ----

export const groupInfo = (id: string) => {
  const g = groups.get(id)!
  const nameOf = (m: string) => online.get(m)?.name ?? known.get(m)?.name ?? 'unknown'
  return { id, name: g.name, owner: g.owner, members: [...g.members].map((m) => ({ id: m, name: nameOf(m) })) }
}

export const emitToMembers = (groupId: string, event: string, data: unknown, exceptId?: string) => {
  const g = groups.get(groupId)
  if (!g) return
  for (const m of g.members) {
    if (m === exceptId) continue
    const u = online.get(m)
    if (u) io.to(u.socketId).emit(event, data)
  }
}
