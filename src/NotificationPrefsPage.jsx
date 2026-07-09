import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'

function Toggle({ label, description, value, onChange }) {
  return (
    <div className="notif-row">
      <div className="notif-row-label">
        <span className="notif-row-title">{label}</span>
        {description && <span className="notif-row-desc">{description}</span>}
      </div>
      <button
        type="button"
        className={`toggle-switch ${value ? 'on' : ''}`}
        onClick={() => onChange(!value)}
        aria-pressed={value}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  )
}

export function NotificationPrefsPage({ socket }) {
  const [prefs, setPrefs] = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!socket) return
    const handle = (p) => setPrefs({ messages: !!p.messages, calls: !!p.calls, contact_requests: !!p.contact_requests, mentions: !!p.mentions })
    socket.on('notification-prefs', handle)
    socket.emit('get-notification-prefs')
    return () => socket.off('notification-prefs', handle)
  }, [socket])

  const update = (key, val) => {
    const next = { ...prefs, [key]: val }
    setPrefs(next)
    socket?.emit('save-notification-prefs', next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  if (!prefs) return <div className="settings-loading">Loading notification settings…</div>

  return (
    <div style={{ maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.bell}</span>
          Notifications
        </div>
        <div className="privacy-rows">
          <Toggle label="Messages" description="Get notified when you receive a new message" value={prefs.messages} onChange={v => update('messages', v)} />
          <Toggle label="Calls" description="Get notified when you receive an incoming call" value={prefs.calls} onChange={v => update('calls', v)} />
          <Toggle label="Contact Requests" description="Get notified when someone sends you a contact request" value={prefs.contact_requests} onChange={v => update('contact_requests', v)} />
          <Toggle label="Mentions" description="Get notified when you are mentioned in a group" value={prefs.mentions} onChange={v => update('mentions', v)} />
        </div>
      </div>

      {saved && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontSize: '0.9rem' }}>
          {Icon.checkCircle} Preferences saved
        </span>
      )}

      <div className="settings-section" style={{ opacity: 0.5 }}>
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.bell}</span>
          Coming Soon
        </div>
        <div className="privacy-rows">
          <div className="notif-row">
            <div className="notif-row-label">
              <span className="notif-row-title">Group Activity</span>
              <span className="notif-row-desc">Notifications for group events</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>Soon</div>
          </div>
          <div className="notif-row">
            <div className="notif-row-label">
              <span className="notif-row-title">Announcements</span>
              <span className="notif-row-desc">Updates from the Sable team</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>Soon</div>
          </div>
        </div>
      </div>
    </div>
  )
}
