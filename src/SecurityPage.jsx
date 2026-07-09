import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'

const RELATIVE = (ts) => {
  if (!ts) return 'Unknown'
  const diff = Date.now() - Number(ts)
  if (diff < 60_000) return 'Just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return new Date(Number(ts)).toLocaleDateString()
}

export function SecurityPage({ socket }) {
  const [sessions, setSessions] = useState(null)
  const [revoking, setRevoking] = useState(null)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!socket) return
    const handle = (s) => setSessions(s)
    socket.on('sessions', handle)
    socket.emit('get-sessions', (s) => setSessions(s))
    return () => socket.off('sessions', handle)
  }, [socket])

  const revoke = (sessionId) => {
    setRevoking(sessionId)
    socket?.emit('revoke-session', { sessionId })
    setTimeout(() => setRevoking(null), 1000)
  }

  const revokeAll = () => {
    socket?.emit('revoke-all-sessions')
    setConfirmed(false)
  }

  const current = sessions?.find(s => s.isCurrent)
  const others = sessions?.filter(s => !s.isCurrent) || []

  if (!sessions) return <div className="settings-loading">Loading session data…</div>

  return (
    <div style={{ maxWidth: 540, display: 'flex', flexDirection: 'column', gap: 32 }}>

      {/* Current session */}
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.device}</span>
          Current Session
        </div>
        {current ? (
          <div className="session-card current">
            <div className="session-card-icon">{Icon.device}</div>
            <div className="session-card-body">
              <span className="session-device">{current.device_hint || 'Unknown device'}</span>
              <span className="session-meta">Active now · {current.ip || 'IP hidden'}</span>
              <span className="session-meta">Logged in {RELATIVE(current.logged_in_at)}</span>
            </div>
            <span className="session-badge">This device</span>
          </div>
        ) : (
          <p className="empty-sub">No session data available.</p>
        )}
      </div>

      {/* Other sessions */}
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.shield}</span>
          Active Sessions
          {others.length > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--muted)' }}>{others.length} other{others.length > 1 ? 's' : ''}</span>
          )}
        </div>

        {others.length === 0 ? (
          <p className="empty-sub">No other active sessions.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {others.map(s => (
              <div key={s.id} className="session-card">
                <div className="session-card-icon">{Icon.device}</div>
                <div className="session-card-body">
                  <span className="session-device">{s.device_hint || 'Unknown device'}</span>
                  <span className="session-meta">Last active {RELATIVE(s.last_active)} · {s.ip || 'IP hidden'}</span>
                  <span className="session-meta">Logged in {RELATIVE(s.logged_in_at)}</span>
                </div>
                <button
                  type="button"
                  className="secondary danger-btn"
                  disabled={revoking === s.id}
                  onClick={() => revoke(s.id)}
                  style={{ flexShrink: 0, padding: '6px 14px', fontSize: '0.8rem' }}
                >
                  {revoking === s.id ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            ))}

            {!confirmed ? (
              <button type="button" className="secondary" style={{ width: 'auto', alignSelf: 'flex-start', marginTop: 8, padding: '10px 20px' }} onClick={() => setConfirmed(true)}>
                Sign out from all other devices
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                <span style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>Are you sure?</span>
                <button type="button" className="primary danger-btn" style={{ width: 'auto', padding: '8px 18px' }} onClick={revokeAll}>Confirm</button>
                <button type="button" className="secondary" style={{ width: 'auto', padding: '8px 14px' }} onClick={() => setConfirmed(false)}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Login history note */}
      <div className="settings-section" style={{ opacity: 0.6 }}>
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.info}</span>
          Login History
        </div>
        <p className="empty-sub" style={{ marginTop: 0 }}>Detailed login history will be available in a future update. Sessions are currently tracked for the last 20 logins.</p>
      </div>
    </div>
  )
}
