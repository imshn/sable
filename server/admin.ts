// Operator-only analytics. Everything here is metadata the server already
// stores (names, timestamps, counts, session rows) — message content stays
// ciphertext and is only ever surfaced as counts.
//
// Auth: same ADMIN_SECRET as /admin/announce, but failures return 404 so the
// route is indistinguishable from not existing, plus a per-IP lockout so the
// secret can't be brute-forced.
import type { Express, Request, Response, NextFunction } from 'express'
import { db } from './db.js'
import { online } from './state.js'

const DAY = 86_400_000

// ponytail: in-memory per-IP lockout — resets on restart, fine for one relay
const failures = new Map<string, { count: number; until: number }>()
const MAX_FAILS = 5
const LOCKOUT_MS = 15 * 60_000

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '?'
  const f = failures.get(ip)
  if (f && f.until > Date.now()) { res.status(404).json({ detail: 'Not Found' }); return }

  if (!process.env.ADMIN_SECRET || req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    const count = (f?.count ?? 0) + 1
    failures.set(ip, { count, until: count >= MAX_FAILS ? Date.now() + LOCKOUT_MS : 0 })
    res.status(404).json({ detail: 'Not Found' })
    return
  }
  failures.delete(ip)
  next()
}

const count = async (sql: string, args: unknown[] = []): Promise<number> => {
  if (!db) return 0
  const r = await db.execute({ sql, args: args as (string | number)[] })
  return Number(r.rows[0]?.c ?? 0)
}

// day-bucketed counts for the last 30 days: [{ day: '2026-07-10', c: 12 }]
const series = async (table: string, tsCol: string, where = ''): Promise<{ day: string; c: number }[]> => {
  if (!db) return []
  const r = await db.execute({
    sql: `SELECT strftime('%Y-%m-%d', ${tsCol}/1000, 'unixepoch') AS day, COUNT(*) AS c
          FROM ${table} WHERE ${tsCol} > ? ${where ? `AND ${where}` : ''}
          GROUP BY day ORDER BY day`,
    args: [Date.now() - 30 * DAY],
  })
  return r.rows.map((row) => ({ day: String(row.day), c: Number(row.c) }))
}

export function registerAdmin(app: Express): void {
  app.get('/admin/stats', requireAdmin, async (_req, res) => {
    const now = Date.now()

    // messages: recipient != sender filters out self-copies so a 1:1 message
    // counts once; group messages count per recipient (relay volume)
    const [
      users, newUsers7d, dau, groupCount, contactPairs, pushSubs, reports,
      messagesRelayed, messages24h, activeSessions24h,
      signups, logins, messages,
    ] = await Promise.all([
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0`),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND created_at > ?`, [now - 7 * DAY]),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND last_seen > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM groups`),
      count(`SELECT COUNT(*) c FROM contacts WHERE status='accepted'`),
      count(`SELECT COUNT(*) c FROM push_subscriptions`),
      count(`SELECT COUNT(*) c FROM user_reports`),
      count(`SELECT COUNT(*) c FROM messages WHERE recipient != sender`),
      count(`SELECT COUNT(*) c FROM messages WHERE recipient != sender AND ts > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM user_sessions WHERE revoked=0 AND last_active > ?`, [now - DAY]),
      series('users', 'created_at', 'deleted=0'),
      series('user_sessions', 'logged_in_at'),
      series('messages', 'ts', 'recipient != sender'),
    ])

    let userRows: unknown[] = []
    let recentLogins: unknown[] = []
    let reportRows: unknown[] = []
    if (db) {
      // ponytail: caps at 500 most-recently-seen users; page it if Sable outgrows that
      const u = await db.execute(`
        SELECT u.id, u.name, u.username, u.created_at, u.last_seen, u.deleted,
               (SELECT COUNT(*) FROM messages m WHERE m.sender = u.id AND m.recipient != m.sender) AS messages,
               (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id) AS sessions
        FROM users u ORDER BY u.last_seen DESC LIMIT 500`)
      userRows = u.rows.map((r) => ({
        id: r.id, name: r.name, username: r.username,
        created_at: Number(r.created_at), last_seen: Number(r.last_seen),
        deleted: !!r.deleted, messages: Number(r.messages), sessions: Number(r.sessions),
        online: online.has(String(r.id)),
      }))
      const l = await db.execute(`
        SELECT s.user_id, u.name, s.ip, s.device_hint, s.logged_in_at, s.last_active, s.revoked
        FROM user_sessions s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.logged_in_at DESC LIMIT 25`)
      recentLogins = l.rows.map((r) => ({
        userId: r.user_id, name: r.name, ip: r.ip, device: r.device_hint,
        loggedInAt: Number(r.logged_in_at), lastActive: Number(r.last_active), revoked: !!r.revoked,
      }))
      const rep = await db.execute(`
        SELECT r.id, r.reporter_id, r.reported_id, r.category, r.details, r.created_at
        FROM user_reports r ORDER BY r.created_at DESC LIMIT 25`)
      reportRows = rep.rows.map((r) => ({
        id: r.id, reporterId: r.reporter_id, reportedId: r.reported_id,
        category: r.category, details: r.details, createdAt: Number(r.created_at),
      }))
    }

    res.json({
      generatedAt: now,
      totals: {
        users, newUsers7d, dau, groups: groupCount, contactPairs, pushSubs,
        reports, messagesRelayed, messages24h, activeSessions24h,
      },
      online: {
        count: online.size,
        users: [...online.entries()].map(([id, u]) => ({ id, name: u.name, username: u.username })),
      },
      series: { signups, logins, messages },
      users: userRows,
      recentLogins,
      reports: reportRows,
    })
  })
}
