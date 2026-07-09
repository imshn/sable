import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'

export function ContactsPage({ contacts, onChat, onVoiceCall, onVideoCall, sendContactRequest, acceptContactRequest, rejectContactRequest, removeContact, socketRef }) {
  const [activeTab, setActiveTab] = useState('contacts') // contacts, requests, search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)

  const pendingRequests = contacts.filter(c => c.status === 'pending' && !c.isRequester)
  const sentRequests = contacts.filter(c => c.status === 'pending' && c.isRequester)
  const acceptedContacts = contacts.filter(c => c.status === 'accepted')

  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return
    const handleResults = (results) => {
      setSearchResults(results)
      setIsSearching(false)
    }
    socket.on('search-results', handleResults)
    return () => socket.off('search-results', handleResults)
  }) // Run on every render to ensure it attaches if socketRef.current was initially null but is now populated

  useEffect(() => {
    if (activeTab === 'search' && searchQuery.trim().length >= 2) {
      setIsSearching(true)
      const timer = setTimeout(() => {
        socketRef.current?.emit('search-users', searchQuery)
      }, 500)
      return () => clearTimeout(timer)
    } else {
      setSearchResults([])
      setIsSearching(false)
    }
  }, [searchQuery, activeTab, socketRef])

  const renderContacts = () => {
    if (acceptedContacts.length === 0) return <div className="empty-state">No contacts yet.</div>
    return (
      <ul className="contact-card-list">
        {acceptedContacts.map(c => (
          <li key={c.id} className="contact-card">
            <div className="contact-card-info">
              <span className="avatar">{c.name.slice(0, 2).toUpperCase()}</span>
              <div className="contact-card-text">
                <span className="name">{c.name}</span>
                <span className="username">@{c.username}</span>
                <span className={`status ${c.online ? 'online' : 'offline'}`}>{c.online ? 'Online' : 'Offline'}</span>
              </div>
            </div>
            <div className="contact-card-actions">
              <button className="icon-btn" onClick={() => onChat(c.id)} title="Chat">{Icon.send}</button>
              <button className="icon-btn" onClick={() => onVoiceCall(c.id)} title="Voice Call">{Icon.call}</button>
              <button className="icon-btn" onClick={() => onVideoCall(c.id)} title="Video Call">{Icon.video}</button>
              <button className="icon-btn danger" onClick={() => removeContact(c.id)} title="Remove Contact">{Icon.trash}</button>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  const renderRequests = () => {
    return (
      <div className="requests-container">
        <h3>Incoming Requests ({pendingRequests.length})</h3>
        {pendingRequests.length === 0 && <div className="empty-state">No pending incoming requests.</div>}
        <ul className="contact-card-list">
          {pendingRequests.map(c => (
            <li key={c.id} className="contact-card">
              <div className="contact-card-info">
                <span className="avatar">{c.name.slice(0, 2).toUpperCase()}</span>
                <div className="contact-card-text">
                  <span className="name">{c.name}</span>
                  <span className="username">@{c.username}</span>
                </div>
              </div>
              <div className="contact-card-actions">
                <button className="primary" onClick={() => acceptContactRequest(c.id)}>Accept</button>
                <button className="secondary" onClick={() => rejectContactRequest(c.id)}>Reject</button>
              </div>
            </li>
          ))}
        </ul>

        <h3 style={{ marginTop: '2rem' }}>Sent Requests ({sentRequests.length})</h3>
        {sentRequests.length === 0 && <div className="empty-state">No pending sent requests.</div>}
        <ul className="contact-card-list">
          {sentRequests.map(c => (
            <li key={c.id} className="contact-card">
              <div className="contact-card-info">
                <span className="avatar">{c.name.slice(0, 2).toUpperCase()}</span>
                <div className="contact-card-text">
                  <span className="name">{c.name}</span>
                  <span className="username">@{c.username}</span>
                </div>
              </div>
              <div className="contact-card-actions">
                <button className="secondary" onClick={() => removeContact(c.id)}>Cancel Request</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const renderSearch = () => {
    return (
      <div className="search-container">
        <input 
          type="text" 
          placeholder="Search by username or name..." 
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="search-input"
          autoFocus
        />
        {isSearching && <div className="search-loading">Searching...</div>}
        {!isSearching && searchResults.length === 0 && searchQuery.trim().length >= 2 && (
          <div className="empty-state">No users found.</div>
        )}
        <ul className="contact-card-list">
          {searchResults.map(u => {
            const existingContact = contacts.find(c => c.id === u.id)
            return (
              <li key={u.id} className="contact-card">
                <div className="contact-card-info">
                  <span className="avatar">{u.name.slice(0, 2).toUpperCase()}</span>
                  <div className="contact-card-text">
                    <span className="name">{u.name}</span>
                    <span className="username">@{u.username}</span>
                  </div>
                </div>
                <div className="contact-card-actions">
                  {existingContact ? (
                    existingContact.status === 'accepted' ? (
                      <button className="secondary" disabled>Already Contacts</button>
                    ) : existingContact.status === 'pending' && existingContact.isRequester ? (
                      <button className="secondary" onClick={() => removeContact(u.id)}>Cancel Request</button>
                    ) : existingContact.status === 'pending' && !existingContact.isRequester ? (
                      <button className="primary" onClick={() => acceptContactRequest(u.id)}>Accept Request</button>
                    ) : (
                      <button className="secondary" disabled>Blocked</button>
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
          <button className={`tab ${activeTab === 'contacts' ? 'active' : ''}`} onClick={() => setActiveTab('contacts')}>My Contacts ({acceptedContacts.length})</button>
          <button className={`tab ${activeTab === 'requests' ? 'active' : ''}`} onClick={() => setActiveTab('requests')}>
            Requests {pendingRequests.length > 0 && <span className="badge">{pendingRequests.length}</span>}
          </button>
          <button className={`tab ${activeTab === 'search' ? 'active' : ''}`} onClick={() => setActiveTab('search')}>Find Users</button>
        </div>
      </header>
      <div className="contacts-content">
        {activeTab === 'contacts' && renderContacts()}
        {activeTab === 'requests' && renderRequests()}
        {activeTab === 'search' && renderSearch()}
      </div>
    </div>
  )
}
