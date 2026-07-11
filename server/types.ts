// Shared server-side types: in-memory presence state, DB row shapes (cast at
// the libsql boundary in db.ts — Row is a dynamic bag, these describe what
// our own queries actually select), and Socket.IO payload/data shapes.
import type { Socket, DefaultEventsMap } from 'socket.io'

export interface OnlineUser {
  socketId: string
  name: string
  username?: string
  pubKey: object
  sessionId: string
  // Which conversation (peerId or groupId) this connection currently has
  // open, so `dm`/`gdm` can still push a notification for a message that
  // arrives while online but not actually being looked at right now.
  activeThread?: string | null
  // Page Visibility API state reported by the client (see set-visibility in
  // presence.ts) — undefined is treated as visible, since a connection is
  // almost always foreground right at hello-time. Lets an incoming call also
  // buzz the OS when the tab is merely backgrounded, not just fully offline.
  visible?: boolean
}

export interface KnownUser {
  name: string
  username?: string
  pubKey: object
  lastSeen: number
}

export interface GroupState {
  name: string
  owner: string
  members: Set<string>
}

// Augments socket.data (see server/index.ts's io.on('connection') handler)
export interface SocketSessionData {
  clientId?: string
  sessionId?: string
  passkeyVerified?: boolean
}

export type AppSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketSessionData>

export interface PushPayload {
  title: string
  body: string
  tag?: string
  url?: string
  // Lets the service worker pick vibrate/requireInteraction/renotify
  // behavior — a ringing call needs to stay on screen and buzz harder than
  // a missed-call follow-up on the same tag, which needs to re-alert rather
  // than silently replace it.
  kind?: 'call-ringing' | 'call-missed'
  // Stamped on right before sending (see notify.ts's pushToSubscriptions) so
  // the service worker can report back which specific push got opened.
  pushId?: string
}

export type PrivacyLevel = 'everyone' | 'contacts' | 'nobody'

export interface PrivacySettingsRow {
  user_id: string
  message_privacy: PrivacyLevel
  call_privacy: PrivacyLevel
  last_seen_privacy: PrivacyLevel
  online_privacy: PrivacyLevel
  avatar_privacy: PrivacyLevel
  bio_privacy: PrivacyLevel
}

export interface NotificationPrefsRow {
  user_id: string
  messages: number
  calls: number
  contact_requests: number
  mentions: number
  group_activity: number
  announcements: number
}

export interface UserRow {
  id: string
  name: string
  username: string
  bio?: string | null
  avatar?: string | null
  pubkey: string
  created_at?: number | null
  updated_at?: number | null
  last_seen: number
  suspended?: number
}

export interface ContactRow {
  requester_id: string
  recipient_id: string
  status: 'pending' | 'accepted' | 'rejected' | 'blocked'
  created_at: number
  updated_at: number
  requester_name: string
  requester_username: string
  requester_avatar: string | null
  requester_pubkey: string
  requester_last_seen: number | null
  recipient_name: string
  recipient_username: string
  recipient_avatar: string | null
  recipient_pubkey: string
  recipient_last_seen: number | null
}

export interface ContactWithPresence extends ContactRow {
  online: boolean
  nickname?: string | null
}

export interface InviteRow {
  id: string
  code: string
  creator_id: string
  created_at: number
  expires_at: number | null
  creator_name: string
  creator_username: string
  creator_avatar: string | null
}

export interface GroupRow {
  id: string
  name: string
  owner: string
  members: string[]
}

export interface MessageRow {
  id: string
  sender: string
  sender_pub: string
  group_id: string | null
  payload: string
  ts: number
  delivered: number
}

export interface UndeliveredRow {
  id: string
  sender: string
}

export interface DeletedConversationRow {
  peer_id: string
  deleted_at: number
}

export interface SessionRow {
  id: string
  socket_id: string | null
  ip: string | null
  user_agent: string | null
  device_hint: string | null
  logged_in_at: number
  last_active: number
}

export interface SessionWithCurrent extends SessionRow {
  isCurrent: boolean
}

export interface LoginHistoryRow {
  id: string
  ip: string | null
  device_hint: string | null
  logged_in_at: number
  last_active: number
  revoked: number
}

export interface PasskeyCredentialRow {
  id: string
  user_id: string
  credential_id: string
  public_key: string
  counter: number
  device_type: string | null
  backed_up: number
  transports: string | null
  created_at: number
  last_used: number | null
}

export interface PasskeySummary {
  id: string
  credentialId: string
  deviceType: string | null
  createdAt: number
  lastUsed: number | null
}

export interface PushSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  created_at: number
}

// Shared per-connection context built once by sockets/presence.ts and passed
// to every other domain module's register function — avoids re-deriving
// clientId/getContact/etc in each module, and lets webauthn-login-verify
// (settings.ts) call the same establishSession() hello uses.
export interface ConnectionCtx {
  ip: string
  ua: string
  deviceHint: string
  clientId: () => string | undefined
  myPub: () => string
  getContact: (fromId: string, toId: string) => Promise<ContactRow | null>
  getContactsWithPresence: (userId: string) => Promise<ContactWithPresence[]>
  establishSession: (args: { id: string; cleanName: string; cleanUsername: string; pubKey: object; via?: 'passkey' | 'passwordless' }) => Promise<void>
}
