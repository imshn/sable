import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'
import { PrivacySettingsPage } from './PrivacySettingsPage.jsx'
import { NotificationPrefsPage } from './NotificationPrefsPage.jsx'
import { SecurityPage } from './SecurityPage.jsx'

const TABS = [
  { id: 'profile',       label: 'Profile',       icon: 'profile'  },
  { id: 'privacy',       label: 'Privacy',        icon: 'lock'     },
  { id: 'notifications', label: 'Notifications',  icon: 'bell'     },
  { id: 'security',      label: 'Security',        icon: 'shield'   },
  { id: 'general',       label: 'General',         icon: 'settings' },
]

export function ProfileSettingsModal({ user, onClose, onUpdateProfile, socket, blockedContacts = [], unblockContact, onShowInvite, onSignOut, passkeys, onFetchPasskeys, onDeletePasskey, onRegisterPasskey, pushEnabled, onEnablePush, onDisablePush }) {
  const [activeTab, setActiveTab] = useState('profile')
  const [name, setName] = useState(user?.name || '')
  const [username, setUsername] = useState(user?.username || '')
  const [bio, setBio] = useState(user?.bio || '')
  const [avatar, setAvatar] = useState(user?.avatar || '')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteInput, setDeleteInput] = useState('')

  useEffect(() => {
    const handleProfileUpdated = (updatedUser) => { setIsSaving(false); onClose(updatedUser) }
    const handleError = (err) => { setIsSaving(false); setError(err) }
    socket.on('profile-updated', handleProfileUpdated)
    socket.on('profile-error', handleError)
    return () => {
      socket.off('profile-updated', handleProfileUpdated)
      socket.off('profile-error', handleError)
    }
  }, [socket, onClose])

  const handleSave = (e) => {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('Display name is required'); return }
    setIsSaving(true)
    onUpdateProfile({ name: name.trim(), username: username.trim(), bio: bio.trim(), avatar: avatar.trim() })
  }

  const handleDeleteAccount = () => {
    if (deleteInput !== username && deleteInput !== name) return
    socket?.emit('delete-account')
  }

  const tabTitle = TABS.find(t => t.id === activeTab)?.label

  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <div
        className="modal profile-modal"
        onClick={e => e.stopPropagation()}
        style={{ display: 'flex', flexDirection: 'row', width: '800px', maxWidth: '95vw', height: '600px', maxHeight: '90vh', padding: 0, overflow: 'hidden' }}
      >
        {/* Left nav */}
        <div className="settings-sidebar" style={{ width: '30%', minWidth: 200, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-alt)' }}>
          <header style={{ padding: '24px 20px', display: 'flex', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1.4rem', margin: 0, fontWeight: 600 }}>Settings</h2>
          </header>

          <div style={{ padding: '8px 12px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {TABS.map(tab => (
              <button
                key={tab.id}
                className={`drawer-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                style={{ fontWeight: activeTab === tab.id ? '600' : 'normal', backgroundColor: activeTab === tab.id ? 'var(--bg-hover)' : 'transparent' }}
              >
                <span className="drawer-glyph">{Icon[tab.icon]}</span>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Sign out pinned at bottom */}
          <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
            <button className="drawer-item danger" onClick={() => { onClose(); onSignOut?.() }}>
              <span className="drawer-glyph" style={{ color: 'var(--danger)' }}>{Icon.signout}</span>
              Sign Out
            </button>
          </div>
        </div>

        {/* Right content */}
        <div className="settings-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg)', position: 'relative' }}>
          <header style={{ padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 500 }}>{tabTitle}</h3>
            <button className="icon-btn subtle" onClick={() => onClose()} title="Close">{Icon.x}</button>
          </header>

          <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
            {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

            {/* PROFILE TAB */}
            {activeTab === 'profile' && (
              <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 480 }}>
                <div className="form-group">
                  <label>Profile Picture URL</label>
                  <div className="avatar-preview-row">
                    <div className="avatar large" style={{ backgroundImage: avatar ? `url(${avatar})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 }}>
                      {!avatar && name.slice(0, 2).toUpperCase()}
                    </div>
                    <input type="url" placeholder="https://…" value={avatar} onChange={e => setAvatar(e.target.value)} />
                  </div>
                </div>

                <div className="form-group">
                  <label>Display Name</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} maxLength={32} required />
                </div>

                <div className="form-group">
                  <label>Username</label>
                  <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Unique username" maxLength={32} />
                </div>

                <div className="form-group">
                  <label>Bio</label>
                  <textarea value={bio} onChange={e => setBio(e.target.value)} placeholder="Tell others about yourself…" maxLength={160} rows={3} />
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)', alignSelf: 'flex-end' }}>{bio.length}/160</span>
                </div>

                <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-start', gap: 12, marginTop: 0 }}>
                  <button type="submit" className="primary" disabled={isSaving}>
                    {isSaving ? 'Saving…' : 'Save Profile'}
                  </button>
                </div>

                {/* Blocked users */}
                {blockedContacts.length > 0 && (
                  <div style={{ marginTop: 16, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
                    <label style={{ marginBottom: 12, display: 'block' }}>Blocked Users</label>
                    <ul className="contact-card-list">
                      {blockedContacts.map(c => (
                        <li key={c.id} className="contact-card" style={{ backgroundColor: 'var(--bg-alt)' }}>
                          <div className="contact-card-info">
                            <span className="avatar">{c.name.slice(0, 2).toUpperCase()}</span>
                            <div className="contact-card-text">
                              <span className="name">{c.name}</span>
                              <span className="username">@{c.username}</span>
                            </div>
                          </div>
                          <div className="contact-card-actions">
                            <button type="button" className="secondary" onClick={() => unblockContact(c.id)}>Unblock</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </form>
            )}

            {/* PRIVACY TAB */}
            {activeTab === 'privacy' && <PrivacySettingsPage socket={socket} />}

            {/* NOTIFICATIONS TAB */}
            {activeTab === 'notifications' && (
              <NotificationPrefsPage
                socket={socket}
                pushEnabled={pushEnabled}
                onEnablePush={onEnablePush}
                onDisablePush={onDisablePush}
              />
            )}

            {/* SECURITY TAB */}
            {activeTab === 'security' && (
              <SecurityPage
                socket={socket}
                passkeys={passkeys}
                onFetchPasskeys={onFetchPasskeys}
                onDeletePasskey={onDeletePasskey}
                onRegisterPasskey={onRegisterPasskey}
              />
            )}

            {/* GENERAL TAB */}
            {activeTab === 'general' && (
              <div style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 28 }}>
                <div className="settings-section">
                  <div className="settings-section-title">
                    <span className="settings-section-icon">{Icon.settings}</span>
                    Appearance
                  </div>
                  <p className="empty-sub" style={{ marginBottom: 12 }}>Choose your preferred theme.</p>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {['dark', 'light'].map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => { document.documentElement.dataset.theme = t; localStorage.setItem('sable-theme', t) }}
                        style={{
                          flex: 1, padding: '12px', borderRadius: 'var(--radius)', border: '2px solid',
                          borderColor: (localStorage.getItem('sable-theme') ?? 'dark') === t ? 'var(--accent)' : 'var(--border)',
                          backgroundColor: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontWeight: 500,
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                          {t === 'dark' ? Icon.moon : Icon.sun}
                          <span style={{ textTransform: 'capitalize' }}>{t}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-title">
                    <span className="settings-section-icon">{Icon.userPlus}</span>
                    Invite a Friend
                  </div>
                  <p className="empty-sub" style={{ marginBottom: 12 }}>Generate a shareable link so someone can connect with you.</p>
                  <button type="button" className="secondary" style={{ width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px' }}
                    onClick={() => { onClose(); onShowInvite?.() }}>
                    {Icon.userPlus} Generate Invite Link
                  </button>
                </div>

                {/* Danger zone */}
                <div className="settings-section" style={{ borderColor: 'var(--danger)', borderWidth: 1, borderStyle: 'solid', borderRadius: 'var(--radius)', padding: 20 }}>
                  <div className="settings-section-title" style={{ color: 'var(--danger)' }}>
                    <span className="settings-section-icon">{Icon.alertCircle}</span>
                    Danger Zone
                  </div>
                  <p className="empty-sub" style={{ marginBottom: 16 }}>Permanently delete your account and all associated data. This cannot be undone.</p>

                  {!showDeleteConfirm ? (
                    <button type="button" className="secondary" style={{ color: 'var(--danger)', borderColor: 'var(--danger)', width: 'auto', padding: '10px 20px' }}
                      onClick={() => setShowDeleteConfirm(true)}>
                      Delete My Account
                    </button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text)' }}>
                        To confirm, type your username <strong>@{username || name}</strong> below:
                      </p>
                      <input
                        type="text"
                        value={deleteInput}
                        onChange={e => setDeleteInput(e.target.value)}
                        placeholder={`@${username || name}`}
                        style={{ maxWidth: 280 }}
                      />
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button
                          type="button"
                          className="primary"
                          style={{ width: 'auto', padding: '8px 18px', backgroundColor: 'var(--danger)' }}
                          disabled={deleteInput !== username && deleteInput !== name && deleteInput !== `@${username}`}
                          onClick={handleDeleteAccount}
                        >
                          Permanently Delete
                        </button>
                        <button type="button" className="secondary" style={{ width: 'auto', padding: '8px 14px' }} onClick={() => { setShowDeleteConfirm(false); setDeleteInput('') }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
