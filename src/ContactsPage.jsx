import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Icon } from './icons.jsx'
import { ConfirmModal } from './ConfirmModal.jsx'

// Deterministic per-person hue so avatars are easier to tell apart at a glance
// in a long list, without needing real profile photos.
const avatarHue = (seed) => {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  return h
}

function PersonRow({ id, name, username, online, children }) {
  const hue = avatarHue(id || name)
  return (
    <div className="contact-card-info">
      <span className="avatar-wrap">
        <span className="avatar" style={{ background: `hsl(${hue} 55% 42%)`, color: '#fff' }}>
          {name.slice(0, 2).toUpperCase()}
        </span>
        {online && <span className="status-dot on avatar-dot" aria-label="Online" />}
      </span>
      <div className="contact-card-text">
        <span className="name">{name}</span>
        <span className="username">@{username}</span>
        {children}
      </div>
    </div>
  )
}

function CardMenu({ items }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="card-menu-wrap" ref={ref}>
      <button type="button" className="icon-btn" title="More" aria-label="More options" onClick={() => setOpen(o => !o)}>
        {Icon.dots}
      </button>
      {open && (
        <div className="drawer card-drawer" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              className={`drawer-item ${it.danger ? 'danger' : ''}`}
              role="menuitem"
              onClick={() => { setOpen(false); it.onClick() }}
            >
              <span className={`drawer-glyph ${it.danger ? 'danger-glyph' : ''}`}>{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ icon, title, hint, action }) {
  return (
    <div className="empty-state rich">
      <span className="empty-state-icon">{icon}</span>
      <span className="empty-state-title">{title}</span>
      {hint && <span className="empty-state-hint">{hint}</span>}
      {action}
    </div>
  )
}

export function ContactsPage({ clientId, contacts, onChat, onVoiceCall, onVideoCall, sendContactRequest, acceptContactRequest, rejectContactRequest, removeContact, blockContact, unblockContact, socketRef }) {
  const [activeTab, setActiveTab] = useState('contacts') // contacts, requests, search
  const [filter, setFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [userToBlock, setUserToBlock] = useState(null)
  const [userToRemove, setUserToRemove] = useState(null)

  const pendingRequests = contacts.filter(c => c.status === 'pending' && !c.isRequester)
  const sentRequests = contacts.filter(c => c.status === 'pending' && c.isRequester)
  const acceptedContacts = contacts.filter(c => c.status === 'accepted')

  const filteredContacts = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const sorted = [...acceptedContacts].sort((a, b) => a.name.localeCompare(b.name))
    if (!q) return sorted
    return sorted.filter(c => c.name.toLowerCase().includes(q) || c.username?.toLowerCase().includes(q))
  }, [acceptedContacts, filter])

  useEffect(() => {
    let active = true
    if (activeTab === 'search' && searchQuery.trim().length >= 2) {
      setIsSearching(true)
      const timer = setTimeout(async () => {
        try {
          const baseUrl = import.meta.env.VITE_RELAY_URL || ''
          const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(searchQuery)}&uid=${encodeURIComponent(clientId)}`)
          if (res.ok && active) {
            const data = await res.json()
            setSearchResults(data.filter(u => u.id !== clientId))
          }
        } catch (e) {
          console.error('search error', e)
        } finally {
          if (active) setIsSearching(false)
        }
      }, 500)
      return () => {
        active = false
        clearTimeout(timer)
      }
    } else {
      setSearchResults([])
      setIsSearching(false)
    }
  }, [searchQuery, activeTab, clientId])

  const renderContacts = () => {
    if (acceptedContacts.length === 0) {
      return (
        <EmptyState
          icon={Icon.users}
          title="No contacts yet"
          hint="Add people by their username to start chatting."
          action={<button type="button" className="primary" style={{ width: 'auto', padding: '10px 20px' }} onClick={() => setActiveTab('search')}>Add People</button>}
        />
      )
    }
    return (
      <>
        <div className="contacts-filter">
          <span className="contacts-filter-icon">{Icon.search}</span>
          <input
            type="text"
            placeholder="Find a contact by name or username…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="search-input"
          />
        </div>
        {filteredContacts.length === 0 ? (
          <div className="empty-state">No contacts match "{filter}".</div>
        ) : (
          <ul className="contact-card-list">
            {filteredContacts.map(c => (
              <li key={c.id} className="contact-card">
                <PersonRow id={c.id} name={c.name} username={c.username} online={c.online}>
                  {c.online && <span className="status online">Online</span>}
                </PersonRow>
                <div className="contact-card-actions">
                  <button className="icon-btn" onClick={() => onChat(c.id)} title="Chat">{Icon.send}</button>
                  <button className="icon-btn" onClick={() => onVoiceCall(c.id)} title="Voice Call">{Icon.call}</button>
                  <button className="icon-btn" onClick={() => onVideoCall(c.id)} title="Video Call">{Icon.video}</button>
                  <CardMenu
                    items={[
                      { label: 'Remove Contact', icon: Icon.trash, danger: true, onClick: () => setUserToRemove(c) },
                      { label: 'Block User', icon: Icon.block, danger: true, onClick: () => setUserToBlock(c) },
                    ]}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }

  const renderRequests = () => {
    return (
      <div className="requests-container">
        <div className="requests-section-head">
          <h3>Incoming</h3>
          {pendingRequests.length > 0 && <span className="session-badge">{pendingRequests.length}</span>}
        </div>
        {pendingRequests.length === 0 ? (
          <div className="empty-state">No pending incoming requests.</div>
        ) : (
          <ul className="contact-card-list">
            {pendingRequests.map(c => (
              <li key={c.id} className="contact-card">
                <PersonRow id={c.id} name={c.name} username={c.username} />
                <div className="contact-card-actions">
                  <button className="secondary" onClick={() => rejectContactRequest(c.id)}>Decline</button>
                  <button className="primary" onClick={() => acceptContactRequest(c.id)}>Accept</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="requests-section-head" style={{ marginTop: '2rem' }}>
          <h3>Sent</h3>
          {sentRequests.length > 0 && <span className="session-badge">{sentRequests.length}</span>}
        </div>
        {sentRequests.length === 0 ? (
          <div className="empty-state">No pending sent requests.</div>
        ) : (
          <ul className="contact-card-list">
            {sentRequests.map(c => (
              <li key={c.id} className="contact-card">
                <PersonRow id={c.id} name={c.name} username={c.username} />
                <div className="contact-card-actions">
                  <span className="session-badge" style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>Pending</span>
                  <button className="secondary" onClick={() => removeContact(c.id)}>Cancel</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const renderSearch = () => {
    return (
      <div className="search-container">
        <div className="contacts-filter">
          <span className="contacts-filter-icon">{Icon.search}</span>
          <input
            type="text"
            placeholder="Search by username or name…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="search-input"
            autoFocus
          />
        </div>
        {searchQuery.trim().length > 0 && searchQuery.trim().length < 2 && (
          <p className="hint" style={{ marginTop: 8 }}>Type at least 2 characters.</p>
        )}
        {isSearching && <div className="search-loading">Searching…</div>}
        {!isSearching && searchResults.length === 0 && searchQuery.trim().length >= 2 && (
          <div className="empty-state">No users found.</div>
        )}
        <ul className="contact-card-list">
          {searchResults.map(u => {
            const existingContact = contacts.find(c => c.id === u.id)
            return (
              <li key={u.id} className="contact-card">
                <PersonRow id={u.id} name={u.name} username={u.username} />
                <div className="contact-card-actions">
                  {existingContact ? (
                    existingContact.status === 'accepted' ? (
                      <span className="session-badge" style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>Already contacts</span>
                    ) : existingContact.status === 'pending' && existingContact.isRequester ? (
                      <button className="secondary" onClick={() => removeContact(u.id)}>Cancel Request</button>
                    ) : existingContact.status === 'pending' && !existingContact.isRequester ? (
                      <button className="primary" onClick={() => acceptContactRequest(u.id)}>Accept Request</button>
                    ) : (
                      <span className="session-badge" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>Blocked</span>
                    )
                  ) : (
                    <button className="primary" onClick={() => sendContactRequest(u.id)}>Add Contact</button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <div className="contacts-page">
      <header className="contacts-header">
        <h2>Contacts</h2>
        <div className="contacts-tabs">
          <button className={`tab ${activeTab === 'contacts' ? 'active' : ''}`} onClick={() => setActiveTab('contacts')}>
            <span className="tab-icon">{Icon.users}</span> My Contacts
          </button>
          <button className={`tab ${activeTab === 'requests' ? 'active' : ''}`} onClick={() => setActiveTab('requests')}>
            <span className="tab-icon">{Icon.bell}</span> Requests {pendingRequests.length > 0 && <span className="badge">{pendingRequests.length}</span>}
          </button>
          <button className={`tab ${activeTab === 'search' ? 'active' : ''}`} onClick={() => setActiveTab('search')}>
            <span className="tab-icon">{Icon.userPlus}</span> Add People
          </button>
        </div>
      </header>
      <div className="contacts-content">
        {activeTab === 'contacts' && renderContacts()}
        {activeTab === 'requests' && renderRequests()}
        {activeTab === 'search' && renderSearch()}
      </div>

      {userToBlock && (
        <ConfirmModal
          title="Block User"
          message={`Are you sure you want to block ${userToBlock.name}? They won't be able to message or call you.`}
          confirmText="Block"
          danger={true}
          onConfirm={() => {
            blockContact(userToBlock.id)
            setUserToBlock(null)
          }}
          onCancel={() => setUserToBlock(null)}
        />
      )}

      {userToRemove && (
        <ConfirmModal
          title="Remove Contact"
          message={`Remove ${userToRemove.name} from your contacts? You can send a new request later if you change your mind.`}
          confirmText="Remove"
          danger={true}
          onConfirm={() => {
            removeContact(userToRemove.id)
            setUserToRemove(null)
          }}
          onCancel={() => setUserToRemove(null)}
        />
      )}
    </div>
  )
}
