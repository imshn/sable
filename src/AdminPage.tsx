import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Icon } from './icons.tsx'
import { avatarBg } from './avatarColor.ts'

// Operator-only dashboard, reachable only by typing /admin — nothing in the
// app links here, and the server answers 404 unless the request carries the
// right ADMIN_SECRET, so to anyone without the key this page is a dead end.

const RELAY = import.meta.env.VITE_RELAY_URL ?? ''
const KEY_STORE = 'sable-admin-key'

interface DayPoint { day: string; c: number }

interface Stats {
  generatedAt: number
  totals: {
    users: number; newUsers7d: number; dau: number; groups: number
    contactPairs: number; pushSubs: number; reports: number
    messagesRelayed: number; messages24h: number; activeSessions24h: number
  }
  online: { count: number; users: { id: string; name: string; username?: string }[] }
  series: { signups: DayPoint[]; logins: DayPoint[]; messages: DayPoint[] }
  users: {
    id: string; name: string; username: string; created_at: number; last_seen: number
    deleted: boolean; messages: number; sessions: number; online: boolean
  }[]
  recentLogins: { userId: string; name?: string; ip?: string; device?: string; loggedInAt: number; lastActive: number; revoked: boolean }[]
  reports: { id: string; reporterId: string; reportedId: string; category: string; details?: string; createdAt: number }[]
}

const fmtDateTime = (ts: number) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtDate = (ts: number) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const relative = (ts: number) => {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// Fills gaps so quiet days render as empty slots instead of vanishing.
function last30Days(points: DayPoint[]): DayPoint[] {
  const byDay = new Map(points.map((p) => [p.day, p.c]))
  const out: DayPoint[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const day = d.toISOString().slice(0, 10)
    out.push({ day, c: byDay.get(day) ?? 0 })
  }
  return out
}

function BarChart({ title, points }: { title: string; points: DayPoint[] }) {
  const days = last30Days(points)
  const max = Math.max(1, ...days.map((d) => d.c))
  const total = days.reduce((s, d) => s + d.c, 0)
  return (
    <div className="admin-chart">
      <div className="admin-chart-head">
        <span>{title}</span>
        <span className="admin-chart-total">{total} / 30d</span>
      </div>
      <div className="admin-chart-bars">
        {days.map((d) => (
          <div key={d.day} className="admin-bar-slot" title={`${d.day}: ${d.c}`}>
            <div className="admin-bar" style={{ height: `${Math.max(d.c > 0 ? 6 : 0, (d.c / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="admin-card">
      <span className="admin-card-value">{value}</span>
      <span className="admin-card-label">{label}</span>
      {sub && <span className="admin-card-sub">{sub}</span>}
    </div>
  )
}

export function AdminPage() {
  const [key, setKey] = useState<string | null>(() => sessionStorage.getItem(KEY_STORE))
  const [input, setInput] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (k: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${RELAY}/admin/stats`, { headers: { 'x-admin-secret': k } })
      if (!res.ok) throw new Error('bad key')
      setStats(await res.json())
      sessionStorage.setItem(KEY_STORE, k)
      setKey(k)
    } catch {
      sessionStorage.removeItem(KEY_STORE)
      setKey(null)
      setStats(null)
      setError('That key was not accepted.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!key) return
    load(key)
    const t = setInterval(() => load(key), 60_000)
    return () => clearInterval(t)
  }, [key, load])

  if (!key || !stats) {
    return (
      <div className="invite-page" style={{ height: '100dvh' }}>
        <div className="invite-card" style={{ maxWidth: 380 }}>
          <span className="invite-card-icon">{Icon.shield}</span>
          <h2>Operator access</h2>
          <p className="hint">This area is restricted.</p>
          {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}
          <form
            style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}
            onSubmit={(e: FormEvent) => { e.preventDefault(); if (input.trim()) load(input.trim()) }}
          >
            <input type="password" placeholder="Admin key" value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
            <button type="submit" className="primary" disabled={loading || !input.trim()}>
              {loading && <span className="btn-spinner" />}Unlock
            </button>
          </form>
        </div>
      </div>
    )
  }

  const t = stats.totals
  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="wordmark compact"><img src="/logo-mark.png" alt="" className="wordmark-logo" /> sable · admin</div>
        <div className="admin-header-actions">
          <span className="admin-updated">updated {relative(stats.generatedAt)}</span>
          <button type="button" className="icon-btn subtle" title="Refresh" onClick={() => load(key)} disabled={loading}>
            {Icon.rotate}
          </button>
          <button
            type="button" className="icon-btn subtle" title="Lock"
            onClick={() => { sessionStorage.removeItem(KEY_STORE); setKey(null); setStats(null) }}
          >
            {Icon.signout}
          </button>
        </div>
      </header>

      <div className="admin-cards">
        <StatCard label="Users" value={t.users} sub={`+${t.newUsers7d} this week`} />
        <StatCard label="Online now" value={stats.online.count} />
        <StatCard label="Active today" value={t.dau} sub="seen in last 24h" />
        <StatCard label="Sessions (24h)" value={t.activeSessions24h} />
        <StatCard label="Messages (24h)" value={t.messages24h} sub={`${t.messagesRelayed} all-time`} />
        <StatCard label="Groups" value={t.groups} />
        <StatCard label="Connections" value={t.contactPairs} sub="accepted contact pairs" />
        <StatCard label="Push devices" value={t.pushSubs} />
      </div>

      <div className="admin-charts">
        <BarChart title="Signups" points={stats.series.signups} />
        <BarChart title="Logins" points={stats.series.logins} />
        <BarChart title="Messages relayed" points={stats.series.messages} />
      </div>

      <section className="admin-section">
        <h3>Online now ({stats.online.count})</h3>
        {stats.online.count === 0 ? (
          <p className="hint">No one is connected right now.</p>
        ) : (
          <div className="admin-online">
            {stats.online.users.map((u) => (
              <span key={u.id} className="admin-chip">
                <span className="avatar small-avatar" style={{ background: avatarBg(u.id), color: '#fff' }}>{u.name.slice(0, 2).toUpperCase()}</span>
                {u.name}{u.username ? ` · @${u.username}` : ''}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h3>Users ({stats.users.length})</h3>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>User</th><th>Username</th><th>Joined</th><th>Last seen</th><th>Messages</th><th>Logins</th><th>Status</th></tr></thead>
            <tbody>
              {stats.users.map((u) => (
                <tr key={u.id} className={u.deleted ? 'deleted' : ''}>
                  <td>{u.name}</td>
                  <td>@{u.username}</td>
                  <td>{fmtDate(u.created_at)}</td>
                  <td>{relative(u.last_seen)}</td>
                  <td>{u.messages}</td>
                  <td>{u.sessions}</td>
                  <td>
                    {u.deleted ? <span className="admin-badge muted">deleted</span>
                      : u.online ? <span className="admin-badge on">online</span>
                      : <span className="admin-badge">offline</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section">
        <h3>Recent logins</h3>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>User</th><th>Device</th><th>IP</th><th>Logged in</th><th>Last active</th><th>Session</th></tr></thead>
            <tbody>
              {stats.recentLogins.map((l, i) => (
                <tr key={i}>
                  <td>{l.name ?? l.userId}</td>
                  <td>{l.device ?? '—'}</td>
                  <td>{l.ip ?? '—'}</td>
                  <td>{fmtDateTime(l.loggedInAt)}</td>
                  <td>{relative(l.lastActive)}</td>
                  <td>{l.revoked ? <span className="admin-badge muted">ended</span> : <span className="admin-badge on">active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section">
        <h3>Reports ({t.reports})</h3>
        {stats.reports.length === 0 ? (
          <p className="hint">No user reports.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Reported</th><th>By</th><th>Category</th><th>Details</th><th>When</th></tr></thead>
              <tbody>
                {stats.reports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.reportedId}</td>
                    <td>{r.reporterId}</td>
                    <td>{r.category}</td>
                    <td className="admin-details">{r.details || '—'}</td>
                    <td>{fmtDateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
