import { useState, useEffect, useMemo, type ReactNode } from 'react'
import type { RefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { Icon } from './icons.tsx'
import { ConfirmModal } from './ConfirmModal.tsx'
import { avatarBg } from './avatarColor.ts'
import type { Contact, SearchUser } from './types.ts'

type ContactsTab = 'contacts' | 'requests' | 'search'

interface RowProps {
  id: string
  name: string
  username: string
  online?: boolean
  trailing?: ReactNode
  sub?: ReactNode
  statusSub?: boolean
  active: boolean
  onClick: () => void
}

function Row({ id, name, username, online, trailing, sub, statusSub, active, onClick }: RowProps) {
  return (
    <button type="button" className={`contact ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="avatar-wrap">
        <span className="avatar" style={{ background: avatarBg(id || name), color: '#fff' }}>
          {name.slice(0, 2).toUpperCase()}
        </span>
        {online && <span className="status-dot on avatar-dot" aria-label="Online" />}
      </span>
      <span className="contact-body">
        <span className="contact-top">
          <span className="contact-name">{name}</span>
          {trailing && <span className="contact-time">{trailing}</span>}
        </span>
        <span className="contact-bottom">
          <span className={`contact-preview ${statusSub ? 'status' : ''}`}>{sub ?? `@${username}`}</span>
        </span>
      </span>
    </button>
  )
}

interface EmptyStateProps {
  icon: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}

function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty-glyph">{icon}</div>
      <p>{title}</p>
      {hint && <p className="empty-sub">{hint}</p>}
      {action}
    </div>
  )
}

// Compact icon+text row for empty/loading states inside the narrow list
// pane — the big EmptyState/.empty treatment above is for the wide detail
// pane and reads as too heavy squeezed into a ~380px column.
function ListEmpty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="list-empty">
      <span className="list-empty-icon">{icon}</span>
      {text}
    </div>
  )
}

type Selected =
  | { kind: 'contact'; person: Contact }
  | { kind: 'incoming'; person: Contact }
  | { kind: 'sent'; person: Contact }
  | { kind: 'search'; person: SearchUser; existingContact?: Contact }
  | null

interface ContactsPageProps {
  clientId: string
  contacts: Contact[]
  onChat: (id: string) => void
  onVoiceCall: (id: string) => void
  onVideoCall: (id: string) => void
  sendContactRequest: (id: string) => void
  acceptContactRequest: (id: string) => void
  rejectContactRequest: (id: string) => void
  removeContact: (id: string) => void
  blockContact: (id: string) => void
  unblockContact: (id: string) => void
  socketRef: RefObject<Socket | null>
}

export function ContactsPage({ clientId, contacts, onChat, onVoiceCall, onVideoCall, sendContactRequest, acceptContactRequest, rejectContactRequest, removeContact, blockContact, unblockContact: _unblockContact, socketRef: _socketRef }: ContactsPageProps) {
  const [activeTab, setActiveTab] = useState<ContactsTab>('contacts')
  const [filter, setFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [userToBlock, setUserToBlock] = useState<Contact | null>(null)
  const [userToRemove, setUserToRemove] = useState<Contact | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const pendingRequests = contacts.filter(c => c.status === 'pending' && !c.isRequester)
  const sentRequests = contacts.filter(c => c.status === 'pending' && c.isRequester)
  const acceptedContacts = contacts.filter(c => c.status === 'accepted')

  const switchTab = (tab: ContactsTab) => { setActiveTab(tab); setSelectedId(null) }

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
            const data: SearchUser[] = await res.json()
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

  // Re-derived from live data every render — so the detail pane never goes
  // stale, and clears itself naturally if the selected person disappears
  // (request accepted/cancelled elsewhere, contact removed, etc).
  const selected: Selected = useMemo(() => {
    if (!selectedId) return null
    const c = acceptedContacts.find(x => x.id === selectedId)
    if (c) return { kind: 'contact', person: c }
    const inc = pendingRequests.find(x => x.id === selectedId)
    if (inc) return { kind: 'incoming', person: inc }
    const sent = sentRequests.find(x => x.id === selectedId)
    if (sent) return { kind: 'sent', person: sent }
    const sr = searchResults.find(x => x.id === selectedId)
    if (sr) return { kind: 'search', person: sr, existingContact: contacts.find(c => c.id === sr.id) }
    return null
  }, [selectedId, acceptedContacts, pendingRequests, sentRequests, searchResults, contacts])

  const renderList = () => {
    if (activeTab === 'contacts') {
      if (acceptedContacts.length === 0) {
        return (
          <div className="contacts-list-scroll">
            <ListEmpty icon={Icon.users} text="No contacts yet." />
          </div>
        )
      }
      return (
        <>
          <div className="contacts-filter">
            <span className="contacts-filter-icon">{Icon.search}</span>
            <input
              type="text"
              placeholder="Find a contact…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="search-input"
            />
          </div>
          <div className="contacts-list-scroll">
            {filteredContacts.length === 0 ? (
              <ListEmpty icon={Icon.search} text={`No contacts match "${filter}".`} />
            ) : (
              filteredContacts.map(c => (
                <Row
                  key={c.id}
                  id={c.id}
                  name={c.name}
                  username={c.username}
                  online={c.online}
                  trailing={c.online ? 'Online' : ''}
                  active={selectedId === c.id}
                  onClick={() => setSelectedId(c.id)}
                />
              ))
            )}
          </div>
        </>
      )
    }

    if (activeTab === 'requests') {
      return (
        <div className="contacts-list-scroll">
          <div className="requests-section-head">
            <h3>Incoming</h3>
            {pendingRequests.length > 0 && <span className="session-badge">{pendingRequests.length}</span>}
          </div>
          {pendingRequests.length === 0 ? (
            <ListEmpty icon={Icon.bell} text="No pending incoming requests." />
          ) : (
            pendingRequests.map(c => (
              <Row key={c.id} id={c.id} name={c.name} username={c.username} active={selectedId === c.id} onClick={() => setSelectedId(c.id)} />
            ))
          )}

          <div className="requests-section-head divider">
            <h3>Sent</h3>
            {sentRequests.length > 0 && <span className="session-badge">{sentRequests.length}</span>}
          </div>
          {sentRequests.length === 0 ? (
            <ListEmpty icon={Icon.send} text="No pending sent requests." />
          ) : (
            sentRequests.map(c => (
              <Row key={c.id} id={c.id} name={c.name} username={c.username} sub="Pending" statusSub active={selectedId === c.id} onClick={() => setSelectedId(c.id)} />
            ))
          )}
        </div>
      )
    }

    // search
    return (
      <>
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
          <p className="hint" style={{ padding: '8px 16px 0' }}>Type at least 2 characters.</p>
        )}
        <div className="contacts-list-scroll">
          {isSearching && <ListEmpty icon={Icon.search} text="Searching…" />}
          {!isSearching && searchResults.length === 0 && searchQuery.trim().length >= 2 && (
            <ListEmpty icon={Icon.search} text="No users found." />
          )}
          {searchResults.map(u => {
            const existingContact = contacts.find(c => c.id === u.id)
            const sub = existingContact?.status === 'accepted' ? 'Already contacts'
              : existingContact?.status === 'pending' && existingContact.isRequester ? 'Pending'
              : existingContact?.status === 'pending' ? 'Sent you a request'
              : existingContact ? 'Blocked'
              : undefined
            return (
              <Row key={u.id} id={u.id} name={u.name} username={u.username} sub={sub} statusSub={!!sub} active={selectedId === u.id} onClick={() => setSelectedId(u.id)} />
            )
          })}
        </div>
      </>
    )
  }

  const renderDetail = () => {
    if (!selected) {
      if (activeTab === 'contacts' && acceptedContacts.length === 0) {
        return (
          <EmptyState
            icon={Icon.users}
            title="No contacts yet"
            hint="Add people by their username to start chatting."
            action={<button type="button" className="primary" style={{ width: 'auto', padding: '10px 20px', marginTop: 8 }} onClick={() => switchTab('search')}>Add People</button>}
          />
        )
      }
      if (activeTab === 'requests' && pendingRequests.length === 0 && sentRequests.length === 0) {
        return <EmptyState icon={Icon.bell} title="No requests" hint="Incoming and sent contact requests will show up here." />
      }
      if (activeTab === 'search') {
        return <EmptyState icon={Icon.userPlus} title="Add someone new" hint="Search by username or name, then select a result to add them." />
      }
      return <EmptyState icon={Icon.users} title="Select someone" hint="Pick a person on the left to see details." />
    }

    const { kind, person } = selected
    const existingContact = selected.kind === 'search' ? selected.existingContact : undefined
    return (
      <div className="profile-detail">
        <span className="avatar-wrap">
          <span className="avatar profile-lg" style={{ background: avatarBg(person.id || person.name), color: '#fff' }}>
            {person.name.slice(0, 2).toUpperCase()}
          </span>
          {kind === 'contact' && person.online && <span className="status-dot on avatar-dot" aria-label="Online" />}
        </span>
        <div className="profile-detail-name">{person.name}</div>
        <div className="profile-detail-username">@{person.username}</div>
        {kind === 'contact' && <div className={`status ${person.online ? 'online' : 'offline'}`}>{person.online ? 'Online' : 'Offline'}</div>}

        {kind === 'contact' && (
          <>
            <div className="profile-detail-actions">
              <button className="call-btn" onClick={() => onChat(person.id)} aria-label="Chat">
                {Icon.send}<span className="call-btn-label">Chat</span>
              </button>
              <button className="call-btn" onClick={() => onVoiceCall(person.id)} aria-label="Voice call">
                {Icon.call}<span className="call-btn-label">Call</span>
              </button>
              <button className="call-btn" onClick={() => onVideoCall(person.id)} aria-label="Video call">
                {Icon.video}<span className="call-btn-label">Video</span>
              </button>
            </div>
            <div className="profile-detail-danger">
              <button className="drawer-item danger" onClick={() => setUserToRemove(person)}>
                <span className="drawer-glyph danger-glyph">{Icon.trash}</span> Remove Contact
              </button>
              <button className="drawer-item danger" onClick={() => setUserToBlock(person)}>
                <span className="drawer-glyph danger-glyph">{Icon.block}</span> Block User
              </button>
            </div>
          </>
        )}

        {kind === 'incoming' && (
          <>
            <p className="profile-detail-note">Sent you a contact request.</p>
            <div className="profile-detail-buttons">
              <button className="secondary" onClick={() => rejectContactRequest(person.id)}>Decline</button>
              <button className="primary" onClick={() => acceptContactRequest(person.id)}>Accept</button>
            </div>
          </>
        )}

        {kind === 'sent' && (
          <>
            <p className="profile-detail-note">Request pending.</p>
            <div className="profile-detail-buttons">
              <button className="secondary" onClick={() => removeContact(person.id)}>Cancel Request</button>
            </div>
          </>
        )}

        {kind === 'search' && (
          <div className="profile-detail-buttons">
            {existingContact ? (
              existingContact.status === 'accepted' ? (
                <span className="session-badge" style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>Already contacts</span>
              ) : existingContact.status === 'pending' && existingContact.isRequester ? (
                <button className="secondary" onClick={() => removeContact(person.id)}>Cancel Request</button>
              ) : existingContact.status === 'pending' ? (
                <button className="primary" onClick={() => acceptContactRequest(person.id)}>Accept Request</button>
              ) : (
                <span className="session-badge" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>Blocked</span>
              )
            ) : (
              <button className="primary" onClick={() => sendContactRequest(person.id)}>Add Contact</button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="contacts-page">
      <header className="contacts-header">
        <h2>Contacts</h2>
        <div className="contacts-tabs">
          <button className={`tab ${activeTab === 'contacts' ? 'active' : ''}`} onClick={() => switchTab('contacts')}>
            <span className="tab-icon">{Icon.users}</span> My Contacts
          </button>
          <button className={`tab ${activeTab === 'requests' ? 'active' : ''}`} onClick={() => switchTab('requests')}>
            <span className="tab-icon">{Icon.bell}</span> Requests {pendingRequests.length > 0 && <span className="badge">{pendingRequests.length}</span>}
          </button>
          <button className={`tab ${activeTab === 'search' ? 'active' : ''}`} onClick={() => switchTab('search')}>
            <span className="tab-icon">{Icon.userPlus}</span> Add People
          </button>
        </div>
      </header>
      <div className="contacts-body">
        <div className="contacts-list-pane">{renderList()}</div>
        <div className="contacts-detail-pane">{renderDetail()}</div>
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
            setSelectedId(null)
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
            setSelectedId(null)
          }}
          onCancel={() => setUserToRemove(null)}
        />
      )}
    </div>
  )
}
