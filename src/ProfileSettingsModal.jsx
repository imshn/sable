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
      <div className="modal profile-modal" onClick={e => e.stopPropagation()}>
        <header className="modal-head" style={{ paddingBottom: '0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingBottom: '12px' }}>
            <h3>Settings</h3>
            <button className="icon-btn subtle" onClick={() => onClose()} title="Close">{Icon.x}</button>
          </div>
          <div className="contacts-tabs" style={{ padding: '0', borderBottom: '1px solid var(--border)' }}>
            <button 
              className={`tab ${activeTab === 'profile' ? 'active' : ''}`} 
              onClick={() => setActiveTab('profile')}
              style={{ flex: 1, textAlign: 'center' }}
            >
              Profile
            </button>
            <button 
              className={`tab ${activeTab === 'privacy' ? 'active' : ''}`} 
              onClick={() => setActiveTab('privacy')}
              style={{ flex: 1, textAlign: 'center' }}
            >
              Privacy
            </button>
          </div>
        </header>

        <form onSubmit={handleSave} className="modal-content" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {error && <div className="error-banner">{error}</div>}
          
          {activeTab === 'profile' ? (
            <>
              <div className="form-group">
                <label>Profile Picture URL</label>
                <div className="avatar-preview-row">
                  <div className="avatar large" style={{ backgroundImage: avatar ? `url(${avatar})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center' }}>
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
              
              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '16px' }}>
                <button type="button" className="secondary" onClick={() => onClose()}>Cancel</button>
                <button type="submit" className="primary" disabled={isSaving}>
                  {isSaving ? 'Saving...' : 'Save Profile'}
                </button>
              </div>
            </>
          ) : (
            <div className="privacy-section">
              <div className="form-group privacy-placeholder">
                <label>Privacy & Security</label>
                <p className="empty-sub">More privacy controls will be available here soon.</p>
              </div>
              
              <div className="blocked-list-section" style={{ marginTop: '24px' }}>
                <label>Blocked Users</label>
                {blockedContacts.length === 0 ? (
                  <p className="empty-sub">You haven't blocked anyone.</p>
                ) : (
                  <ul className="contact-card-list" style={{ marginTop: '12px' }}>
                    {blockedContacts.map(c => (
                      <li key={c.id} className="contact-card">
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


        </form>
      </div>
    </div>
  )
}
