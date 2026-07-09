import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'

export function ProfileSettingsModal({ user, onClose, onUpdateProfile, socket, blockedContacts = [], unblockContact }) {
  const [activeTab, setActiveTab] = useState('profile') // 'profile' or 'privacy'
  const [name, setName] = useState(user?.name || '')
  const [username, setUsername] = useState(user?.username || '')
  const [bio, setBio] = useState(user?.bio || '')
  const [avatar, setAvatar] = useState(user?.avatar || '')
  
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handleProfileUpdated = (updatedUser) => {
      setIsSaving(false)
      onClose(updatedUser)
    }
    const handleError = (err) => {
      setIsSaving(false)
      setError(err)
    }
    
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
    
    if (!name.trim()) {
      setError('Display name is required')
      return
    }
    
    setIsSaving(true)
    onUpdateProfile({ 
      name: name.trim(), 
      username: username.trim(), 
      bio: bio.trim(), 
      avatar: avatar.trim() 
    })
  }

  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <div className="modal profile-modal" onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'row', width: '800px', maxWidth: '95vw', height: '600px', maxHeight: '90vh', padding: 0, overflow: 'hidden' }}>
        
        <div className="settings-sidebar" style={{ width: '30%', minWidth: '200px', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-alt)' }}>
          <header style={{ padding: '24px 20px', display: 'flex', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1.4rem', margin: 0, fontWeight: '600' }}>Settings</h2>
          </header>
          <div style={{ padding: '8px 12px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <button 
              className={`drawer-item ${activeTab === 'profile' ? 'active' : ''}`} 
              onClick={() => setActiveTab('profile')}
              style={{ fontWeight: activeTab === 'profile' ? '600' : 'normal', backgroundColor: activeTab === 'profile' ? 'var(--bg-hover)' : 'transparent' }}
            >
              <span className="drawer-glyph">{Icon.settings}</span> Profile
            </button>
            <button 
              className={`drawer-item ${activeTab === 'privacy' ? 'active' : ''}`} 
              onClick={() => setActiveTab('privacy')}
              style={{ fontWeight: activeTab === 'privacy' ? '600' : 'normal', backgroundColor: activeTab === 'privacy' ? 'var(--bg-hover)' : 'transparent' }}
            >
              <span className="drawer-glyph">{Icon.lock}</span> Privacy
            </button>
          </div>
        </div>

        <div className="settings-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg)', position: 'relative' }}>
          <header style={{ padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: '500' }}>
              {activeTab === 'profile' ? 'Profile Details' : 'Privacy Settings'}
            </h3>
            <button className="icon-btn subtle" onClick={() => onClose()} title="Close">{Icon.x}</button>
          </header>

          <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            {error && <div className="error-banner" style={{ marginBottom: '16px' }}>{error}</div>}
            
            {activeTab === 'profile' ? (
              <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '480px' }}>
                <div className="form-group">
                  <label>Profile Picture URL</label>
                  <div className="avatar-preview-row">
                    <div className="avatar large" style={{ backgroundImage: avatar ? `url(${avatar})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 }}>
                      {!avatar && name.slice(0, 2).toUpperCase()}
                    </div>
                    <input 
                      type="url" 
                      placeholder="https://..." 
                      value={avatar}
                      onChange={(e) => setAvatar(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Display Name</label>
                  <input 
                    type="text" 
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={32}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Username</label>
                  <input 
                    type="text" 
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Unique username"
                    maxLength={32}
                  />
                </div>

                <div className="form-group">
                  <label>Bio</label>
                  <textarea 
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Tell others about yourself..."
                    maxLength={160}
                    rows={3}
                  />
                </div>
                
                <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-start', gap: '12px', marginTop: '16px' }}>
                  <button type="submit" className="primary" disabled={isSaving}>
                    {isSaving ? 'Saving...' : 'Save Profile'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="privacy-section" style={{ maxWidth: '480px' }}>
                <div className="form-group privacy-placeholder">
                  <label>Privacy & Security</label>
                  <p className="empty-sub">More privacy controls will be available here soon.</p>
                </div>
                
                <div className="blocked-list-section" style={{ marginTop: '32px' }}>
                  <label>Blocked Users</label>
                  {blockedContacts.length === 0 ? (
                    <p className="empty-sub" style={{ marginTop: '8px' }}>You haven't blocked anyone.</p>
                  ) : (
                    <ul className="contact-card-list" style={{ marginTop: '16px' }}>
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
