import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'

export function ProfileSettingsModal({ user, onClose, onUpdateProfile, socket }) {
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
        <header className="modal-head">
          <h3>Profile Settings</h3>
          <button className="icon-btn subtle" onClick={() => onClose()} title="Close">{Icon.x}</button>
        </header>

        <form onSubmit={handleSave} className="modal-content" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {error && <div className="error-banner">{error}</div>}
          
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

          <div className="form-group privacy-placeholder">
            <label>Privacy & Security</label>
            <p className="empty-sub">Privacy controls (who can see your online status, last seen, etc.) will be available here soon.</p>
          </div>

          <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '16px' }}>
            <button type="button" className="secondary" onClick={() => onClose()}>Cancel</button>
            <button type="submit" className="primary" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
