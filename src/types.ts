// Shared domain types for the frontend. Socket.IO payloads are intentionally
// NOT exhaustively typed here — there are ~50 distinct events across chat,
// contacts, groups, calls, and settings, and the ROI of typing the data models
// below (where real bugs happen: wrong field names, missing null checks) is
// far higher than a fully generic Socket<ServerToClientEvents,...> map would
// be. Socket handlers destructure `any`-typed event payloads and immediately
// assign into these typed shapes, so mistakes still surface at the boundary.

export type JsonWebKeyPub = JsonWebKey

export interface EncryptedPayload {
  iv: string
  ct: string
}

export type ContactStatus = 'accepted' | 'pending' | 'blocked'

export interface Contact {
  id: string
  name: string
  username: string
  avatar?: string | null
  pubKey: JsonWebKeyPub
  status: ContactStatus
  isRequester: boolean
  lastSeen?: number | null
  online?: boolean
  // Private label only I see — set via setContactNickname. When present,
  // `name` above is already this value; `realName` is their actual name,
  // kept around only so the nickname editor has something to prefill from.
  nickname?: string | null
  realName: string
}

export interface SearchUser {
  id: string
  name: string
  username: string
  avatar?: string | null
}

export interface GroupMember {
  id: string
  name: string
}

export interface Group {
  id: string
  name: string
  owner: string
  members: GroupMember[]
}

export type MessageKind = 'self' | 'peer' | 'sys' | 'call' | 'error'
export type MessageStatus = 'sent' | 'delivered' | 'read' | undefined

export interface MentionRef {
  id: string
  name: string
}

export interface ReplyRef {
  id: string
  name: string
  preview: string
}

export interface TextBody {
  t: 'text'
  text: string
  mentions?: MentionRef[]
  reply?: ReplyRef
  fwd?: boolean
}

export interface FileBody {
  t: 'file'
  name: string
  mime: string
  size: number
  data?: string // base64, present until toBody() replaces it with an object URL
  url?: string
  caption?: string
  voice?: boolean
  reply?: ReplyRef
  fwd?: boolean
}

export interface LocationBody {
  t: 'loc'
  lat: number
  lng: number
  reply?: ReplyRef
  fwd?: boolean
}

export interface CallLogBody {
  kind: 'ended' | 'missed' | 'declined' | 'cancelled' | 'media-error'
  dur?: number
}

export type MessageBody = TextBody | FileBody | LocationBody | CallLogBody | { text: string }

export interface ReactControlEnvelope {
  t: 'react'
  msgId: string
  emoji: string | null
}

export interface DeleteControlEnvelope {
  t: 'delete'
  msgId: string
}

export type ControlEnvelope = ReactControlEnvelope | DeleteControlEnvelope

// What sendEnvelope() actually seals and transmits — a content body plus the
// bookkeeping fields the encrypted payload carries end-to-end (self-copy
// routing, forward flag). ControlEnvelope rides the same wire path.
export type OutgoingEnvelope = (TextBody | FileBody | LocationBody) & { _to?: string; fwd?: boolean } | ControlEnvelope

export interface ConvoMessage {
  id: string
  kind: MessageKind
  body: MessageBody
  ts: number
  from?: string
  name?: string
  status?: MessageStatus
  deleted?: boolean
  reactions?: Record<string, string>
}

// The chat/call target passed into Thread/CallOverlay — either a 1:1 contact
// or a group, normalized to one shape by the caller (App.tsx).
export interface ChatTarget {
  id: string
  name: string
  online?: boolean
  isGroup?: boolean
  members?: GroupMember[]
  owner?: string
  mine?: boolean
  status?: ContactStatus
  isRequester?: boolean
}

export interface Convo {
  messages: ConvoMessage[]
  unread: number
  lastTs: number
  typing: string | null
}

export type CallMode = 'direct' | 'group'
export type CallStatus = 'idle' | 'incoming' | 'outgoing' | 'active'

export interface CallState {
  status: CallStatus
  mode?: CallMode
  peerId?: string
  groupId?: string
  callerName?: string
  video?: boolean
}

export type QualityLevel = 'excellent' | 'good' | 'poor'

export interface QualitySample {
  level: QualityLevel
  rttMs: number | null
  lossPct: number
  kbps: number
}

export interface PrivacySettings {
  user_id: string
  message_privacy: 'everyone' | 'contacts' | 'nobody'
  call_privacy: 'everyone' | 'contacts' | 'nobody'
  last_seen_privacy: 'everyone' | 'contacts' | 'nobody'
  online_privacy: 'everyone' | 'contacts' | 'nobody'
  avatar_privacy: 'everyone' | 'contacts' | 'nobody'
  bio_privacy: 'everyone' | 'contacts' | 'nobody'
}

export interface NotificationPrefs {
  user_id?: string
  messages: boolean | number
  calls: boolean | number
  contact_requests: boolean | number
  mentions: boolean | number
  group_activity: boolean | number
  announcements: boolean | number
}

export interface SessionRow {
  id: string
  device_hint: string | null
  ip: string | null
  logged_in_at: number
  last_active: number
  isCurrent?: boolean
}

export interface LoginHistoryRow {
  id: string
  device_hint: string | null
  ip: string | null
  logged_in_at: number
  last_active: number
  revoked: number
}

export interface Passkey {
  id: string
  credentialId: string
  deviceType: string
  backedUp: boolean
  createdAt: number
  lastUsed: number | null
}

export interface Announcement {
  title: string
  body: string
  ts: number
}

export interface PasskeyActionResult {
  ok?: boolean
  error?: string
}

export interface MyProfile {
  id: string
  name: string
  username: string
  bio?: string
  avatar?: string
}
