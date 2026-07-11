// Turso (libSQL) persistence. Everything stored is either public-by-design
// (names, public keys, group rosters) or ciphertext the server cannot read.
// Without TURSO_DATABASE_URL the relay runs memory-only, exactly as before.
import { createClient, type Client } from '@libsql/client'
import { env } from './config.js'
import type {
  UserRow, ContactRow, InviteRow, GroupRow, MessageRow, UndeliveredRow,
  DeletedConversationRow, PrivacySettingsRow, NotificationPrefsRow, SessionRow,
  LoginHistoryRow, PasskeyCredentialRow, PushSubscriptionRow,
} from './types.js'

const url = env.TURSO_DATABASE_URL
const authToken = env.TURSO_AUTH_TOKEN

export const db: Client | null = url ? createClient({ url, authToken }) : null

export async function migrate(): Promise<void> {
  if (!db) {
    console.log('no TURSO_DATABASE_URL — running memory-only (no history, no offline delivery)')
    return
  }
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      last_seen INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      PRIMARY KEY (group_id, member_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_pub TEXT NOT NULL,
      group_id TEXT,
      payload TEXT NOT NULL,
      ts INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, recipient)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages (recipient, ts)`,
    `CREATE TABLE IF NOT EXISTS contacts (
      requester_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (requester_id, recipient_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status)`,
    // Private per-owner display name for a contact — never visible to the
    // contact themselves or anyone else, only the person who set it.
    `CREATE TABLE IF NOT EXISTS contact_nicknames (
      owner_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      PRIMARY KEY (owner_id, contact_id)
    )`,
    `CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      creator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )`,
    // Privacy settings — all default to 'everyone'
    `CREATE TABLE IF NOT EXISTS privacy_settings (
      user_id TEXT PRIMARY KEY,
      message_privacy TEXT NOT NULL DEFAULT 'everyone',
      call_privacy TEXT NOT NULL DEFAULT 'everyone',
      last_seen_privacy TEXT NOT NULL DEFAULT 'everyone',
      online_privacy TEXT NOT NULL DEFAULT 'everyone',
      avatar_privacy TEXT NOT NULL DEFAULT 'everyone',
      bio_privacy TEXT NOT NULL DEFAULT 'everyone'
    )`,
    // User reports for moderation
    `CREATE TABLE IF NOT EXISTS user_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      reported_id TEXT NOT NULL,
      category TEXT NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reports_reported ON user_reports(reported_id)`,
    // Notification preferences
    `CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY,
      messages INTEGER NOT NULL DEFAULT 1,
      calls INTEGER NOT NULL DEFAULT 1,
      contact_requests INTEGER NOT NULL DEFAULT 1,
      mentions INTEGER NOT NULL DEFAULT 1,
      group_activity INTEGER NOT NULL DEFAULT 1,
      announcements INTEGER NOT NULL DEFAULT 1
    )`,
    // Session tracking (lightweight — option A, trust model unchanged)
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      socket_id TEXT,
      ip TEXT,
      user_agent TEXT,
      device_hint TEXT,
      logged_in_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id)`,
    // Passkey credentials (WebAuthn)
    `CREATE TABLE IF NOT EXISTS passkey_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at INTEGER NOT NULL,
      last_used INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkey_credentials(user_id)`,
    // Soft-delete: track which users have deleted a conversation on their side
    `CREATE TABLE IF NOT EXISTS deleted_conversations (
      user_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, peer_id)
    )`,
    // Web Push subscriptions — one row per browser/device that opted in.
    // Only ever targeted when that user has zero live socket connections.
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)`,
    // Call initiations, metadata only (who rang whom, video or voice, when) —
    // media is peer-to-peer so this is all the server can ever know anyway.
    `CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      caller TEXT NOT NULL,
      callee TEXT,
      group_id TEXT,
      video INTEGER NOT NULL DEFAULT 1,
      ts INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_call_logs_ts ON call_logs(ts)`,
    // Push delivery attempts — for the notification-analytics section only;
    // sendPush already decides ok/expired, this just keeps a record of it.
    `CREATE TABLE IF NOT EXISTS push_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tag TEXT,
      ok INTEGER NOT NULL,
      expired INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_push_log_ts ON push_log(ts)`,
    // Failed auth attempts (username taken, expired/rejected passkey ceremony)
    // — the security-dashboard signal analogous to what "JWT errors" would be
    // in a token-based app; this one has no tokens, so this is the real one.
    `CREATE TABLE IF NOT EXISTS failed_logins (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      ip TEXT,
      reason TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_failed_logins_ts ON failed_logins(ts)`,
    // Every mutating action taken from the admin panel itself.
    `CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      ip TEXT,
      ts INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON admin_audit_log(ts)`,
    // User-level security audit trail (passkey changes, privacy changes,
    // account deletion, session revocations) — separate from admin actions
    // and from application logs, queryable per user.
    `CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      ts INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, ts)`,
    `CREATE TABLE IF NOT EXISTS feature_flags (
      key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ], 'write')

  // Safely add columns using a helper that swallows "column already exists" errors
  const addCol = async (sql: string) => { try { await db!.execute(sql) } catch { /* ignores if exists */ } }
  await addCol("ALTER TABLE users ADD COLUMN username TEXT")
  await addCol("ALTER TABLE users ADD COLUMN avatar TEXT")
  await addCol("ALTER TABLE users ADD COLUMN bio TEXT")
  await addCol("ALTER TABLE users ADD COLUMN created_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0")
  await addCol("ALTER TABLE user_sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'passwordless'")
  await addCol("ALTER TABLE call_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'ringing'")
  await addCol("ALTER TABLE call_logs ADD COLUMN answered_at INTEGER")
  await addCol("ALTER TABLE call_logs ADD COLUMN ended_at INTEGER")
  await addCol("ALTER TABLE call_logs ADD COLUMN relay TEXT")
  await addCol("ALTER TABLE user_reports ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0")
  await addCol("ALTER TABLE invitations ADD COLUMN used_at INTEGER")
  await addCol("ALTER TABLE push_log ADD COLUMN opened_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN updated_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
  await addCol("ALTER TABLE privacy_settings ADD COLUMN bio_privacy TEXT NOT NULL DEFAULT 'everyone'")
  await addCol("ALTER TABLE notification_preferences ADD COLUMN group_activity INTEGER NOT NULL DEFAULT 1")
  await addCol("ALTER TABLE notification_preferences ADD COLUMN announcements INTEGER NOT NULL DEFAULT 1")

  // Fallback for existing users and index
  await db.execute("UPDATE users SET username = 'user_' || substr(id, 1, 6) WHERE username IS NULL")
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")

  // Hot-path indexes (Phase 5 performance pass):
  await db.batch([
    // getContactPair / getContacts hit both sides of the pair; the PK only
    // covers requester_id-first lookups
    `CREATE INDEX IF NOT EXISTS idx_contacts_recipient ON contacts(recipient_id)`,
    // countRecentFailedLogins runs on every single hello
    `CREATE INDEX IF NOT EXISTS idx_failed_logins_ip_ts ON failed_logins(ip, ts)`,
    // findOpenCall runs on every call answer/decline/end/relay-info
    `CREATE INDEX IF NOT EXISTS idx_call_logs_pair ON call_logs(caller, callee, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_call_logs_group_ts ON call_logs(group_id, ts)`,
    // admin user-table per-user counts
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)`,
    `CREATE INDEX IF NOT EXISTS idx_invitations_creator ON invitations(creator_id)`,
  ], 'write')

  // Seed defaults — INSERT OR IGNORE so an operator's saved change is never
  // clobbered by a redeploy re-running this.
  const now = Date.now()
  for (const key of ['voice_calls', 'video_calls', 'screen_share', 'push_notifications', 'groups', 'registration']) {
    await db.execute({ sql: `INSERT OR IGNORE INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?)`, args: [key, now] })
  }
  for (const [key, value] of Object.entries({
    max_upload_mb: '25', max_group_participants: '32', invite_expiry_hours: '168',
    session_timeout_hours: '720', push_retry_count: '2',
  })) {
    await db.execute({ sql: `INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`, args: [key, value, now] })
  }

  console.log('turso: migrated')
}

// fire-and-forget writes — a slow or failing DB must never break live relaying
const safe = (p: Promise<unknown>) => p.catch((e) => console.error('db error', (e as Error).message))

export const store = {
  // ---- Users ----
  upsertUser: (id: string, name: string, pubkey: string, username: string | null = null) => {
    if (!db) return
    if (username) {
      return safe(db.execute({
        sql: `INSERT INTO users (id, name, pubkey, username, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username, pubkey=excluded.pubkey, last_seen=excluded.last_seen, updated_at=excluded.updated_at`,
        args: [id, name, pubkey, username, Date.now(), Date.now(), Date.now()],
      }))
    } else {
      return safe(db.execute({
        sql: `INSERT INTO users (id, name, pubkey, last_seen) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, pubkey=excluded.pubkey, last_seen=excluded.last_seen`,
        args: [id, name, pubkey, Date.now()],
      }))
    }
  },

  checkUsernameAvailable: async (username: string, currentUserId: string): Promise<boolean> => {
    if (!db) return true
    const r = await db.execute({ sql: `SELECT id FROM users WHERE username = ? AND deleted = 0`, args: [username] })
    if (r.rows.length === 0) return true
    return r.rows[0].id === currentUserId
  },

  updateProfile: async (id: string, { name, username, bio, avatar }: { name: string; username: string; bio: string; avatar: string }): Promise<boolean> => {
    if (!db) return false
    try {
      const r = await db.execute({
        sql: `UPDATE users SET name=?, username=?, bio=?, avatar=?, updated_at=? WHERE id=?`,
        args: [name, username, bio, avatar, Date.now(), id]
      })
      return r.rowsAffected > 0
    } catch (e) {
      console.error('db update profile error:', (e as Error).message)
      return false
    }
  },

  getUser: async (id: string): Promise<UserRow | null> => {
    if (!db) return null
    const r = await db.execute({ sql: `SELECT id, name, username, bio, avatar, pubkey, created_at, updated_at, last_seen, suspended FROM users WHERE id=? AND deleted=0`, args: [id] })
    return (r.rows[0] as unknown as UserRow) || null
  },

  touchUser: (id: string) =>
    db && safe(db.execute({ sql: `UPDATE users SET last_seen=? WHERE id=?`, args: [Date.now(), id] })),

  allUsers: async (): Promise<UserRow[]> => {
    if (!db) return []
    const r = await db.execute(`SELECT id, name, username, avatar, pubkey, last_seen FROM users WHERE deleted=0 ORDER BY last_seen DESC LIMIT 200`)
    return r.rows as unknown as UserRow[]
  },

  searchUsers: async (query: string, currentUserId: string, limit = 50): Promise<UserRow[]> => {
    if (!db || !query) return []
    const like = `%${query}%`
    const r = await db.execute({
      sql: `SELECT id, name, username, avatar FROM users
            WHERE (username LIKE ? OR name LIKE ?)
            AND id != ?
            AND deleted = 0
            AND id NOT IN (
              SELECT recipient_id FROM contacts WHERE requester_id = ? AND status = 'blocked'
              UNION
              SELECT requester_id FROM contacts WHERE recipient_id = ? AND status = 'blocked'
            )
            LIMIT ?`,
      args: [like, like, currentUserId, currentUserId, currentUserId, limit]
    })
    return r.rows as unknown as UserRow[]
  },

  // Soft-delete account: anonymize user record, keep message ciphertext for other participants
  deleteAccount: async (userId: string): Promise<void> => {
    if (!db) return
    const anon = `deleted_${userId.slice(0, 8)}`
    await db.execute({
      sql: `UPDATE users SET name=?, username=?, bio='', avatar='', updated_at=?, deleted=1 WHERE id=?`,
      args: [anon, anon, Date.now(), userId]
    })
    // Remove contacts and invitations
    await db.execute({ sql: `DELETE FROM contacts WHERE requester_id=? OR recipient_id=?`, args: [userId, userId] })
    await db.execute({ sql: `DELETE FROM contact_nicknames WHERE owner_id=? OR contact_id=?`, args: [userId, userId] })
    await db.execute({ sql: `DELETE FROM invitations WHERE creator_id=?`, args: [userId] })
    await db.execute({ sql: `DELETE FROM privacy_settings WHERE user_id=?`, args: [userId] })
    await db.execute({ sql: `DELETE FROM notification_preferences WHERE user_id=?`, args: [userId] })
    // Revoke all sessions
    await db.execute({ sql: `UPDATE user_sessions SET revoked=1 WHERE user_id=?`, args: [userId] })
  },

  // ---- Contacts ----
  upsertContact: (requesterId: string, recipientId: string, status: string) =>
    db && safe(db.execute({
      sql: `INSERT INTO contacts (requester_id, recipient_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(requester_id, recipient_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`,
      args: [requesterId, recipientId, status, Date.now(), Date.now()]
    })),

  getContacts: async (userId: string): Promise<ContactRow[]> => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT c.*,
              u1.name as requester_name, u1.username as requester_username, u1.avatar as requester_avatar, u1.pubkey as requester_pubkey, u1.last_seen as requester_last_seen,
              u2.name as recipient_name, u2.username as recipient_username, u2.avatar as recipient_avatar, u2.pubkey as recipient_pubkey, u2.last_seen as recipient_last_seen
            FROM contacts c
            LEFT JOIN users u1 ON c.requester_id = u1.id
            LEFT JOIN users u2 ON c.recipient_id = u2.id
            WHERE (c.requester_id = ? OR c.recipient_id = ?)`,
      args: [userId, userId]
    })
    return r.rows as unknown as ContactRow[]
  },

  // Single-pair lookup for the hot relay paths (dm, typing, every call
  // signaling packet) — the old approach fetched the user's entire contact
  // list with two user-table joins just to find one row.
  getContactPair: async (a: string, b: string): Promise<ContactRow | null> => {
    if (!db) return null
    const r = await db.execute({
      sql: `SELECT * FROM contacts
            WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)
            LIMIT 1`,
      args: [a, b, b, a],
    })
    return (r.rows[0] as unknown as ContactRow) ?? null
  },

  // Batched privacy-settings fetch — one query for a whole contact list
  // instead of one per contact on first (uncached) load.
  getPrivacySettingsBulk: async (userIds: string[]): Promise<Map<string, PrivacySettingsRow>> => {
    const out = new Map<string, PrivacySettingsRow>()
    if (!db || !userIds.length) return out
    const placeholders = userIds.map(() => '?').join(',')
    const r = await db.execute({ sql: `SELECT * FROM privacy_settings WHERE user_id IN (${placeholders})`, args: userIds })
    for (const row of r.rows) out.set(String(row.user_id), row as unknown as PrivacySettingsRow)
    return out
  },

  deleteContact: (requesterId: string, recipientId: string) =>
    db && safe(db.execute({
      sql: `DELETE FROM contacts WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)`,
      args: [requesterId, recipientId, recipientId, requesterId]
    })),

  // ---- Contact nicknames (private per-owner) ----
  setContactNickname: (ownerId: string, contactId: string, nickname: string) =>
    db && safe(nickname
      ? db.execute({
          sql: `INSERT INTO contact_nicknames (owner_id, contact_id, nickname) VALUES (?, ?, ?)
                ON CONFLICT(owner_id, contact_id) DO UPDATE SET nickname=excluded.nickname`,
          args: [ownerId, contactId, nickname],
        })
      : db.execute({ sql: `DELETE FROM contact_nicknames WHERE owner_id = ? AND contact_id = ?`, args: [ownerId, contactId] })),

  getContactNicknames: async (ownerId: string): Promise<Record<string, string>> => {
    if (!db) return {}
    const r = await db.execute({ sql: `SELECT contact_id, nickname FROM contact_nicknames WHERE owner_id = ?`, args: [ownerId] })
    const map: Record<string, string> = {}
    for (const row of r.rows) map[row.contact_id as string] = row.nickname as string
    return map
  },

  // ---- Invitations ----
  createInvite: (id: string, code: string, creatorId: string, expiresAt: number | null) =>
    db && safe(db.execute({
      sql: `INSERT INTO invitations (id, code, creator_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      args: [id, code, creatorId, Date.now(), expiresAt]
    })),

  markInviteUsed: (code: string) =>
    db && safe(db.execute({ sql: `UPDATE invitations SET used_at=? WHERE code=? AND used_at IS NULL`, args: [Date.now(), code] })),

  getInvite: async (code: string): Promise<InviteRow | null> => {
    if (!db) return null
    const r = await db.execute({
      sql: `SELECT i.*, u.name as creator_name, u.username as creator_username, u.avatar as creator_avatar
            FROM invitations i
            JOIN users u ON i.creator_id = u.id
            WHERE i.code = ? AND u.deleted = 0`,
      args: [code]
    })
    return (r.rows[0] as unknown as InviteRow) ?? null
  },

  // ---- Groups ----
  saveGroup: (id: string, name: string, owner: string, memberIds: string[]) =>
    db && safe((async () => {
      await db!.execute({ sql: `INSERT OR REPLACE INTO groups (id, name, owner) VALUES (?, ?, ?)`, args: [id, name, owner] })
      await db!.execute({ sql: `DELETE FROM group_members WHERE group_id=?`, args: [id] })
      for (const m of memberIds) {
        await db!.execute({ sql: `INSERT OR IGNORE INTO group_members (group_id, member_id) VALUES (?, ?)`, args: [id, m] })
      }
    })()),

  deleteGroup: (id: string) =>
    db && safe(db.batch([
      { sql: `DELETE FROM groups WHERE id=?`, args: [id] },
      { sql: `DELETE FROM group_members WHERE group_id=?`, args: [id] },
    ], 'write')),

  loadGroups: async (): Promise<GroupRow[]> => {
    if (!db) return []
    const gs = await db.execute(`SELECT id, name, owner FROM groups`)
    const ms = await db.execute(`SELECT group_id, member_id FROM group_members`)
    return gs.rows.map((g) => ({
      id: g.id as string,
      name: g.name as string,
      owner: g.owner as string,
      members: ms.rows.filter((m) => m.group_id === g.id).map((m) => m.member_id as string),
    }))
  },

  // ---- Messages ----
  saveMessage: (id: string, recipient: string, sender: string, senderPub: string, groupId: string | null, payload: string, ts: number, delivered: boolean) =>
    db && safe(db.execute({
      sql: `INSERT OR IGNORE INTO messages (id, recipient, sender, sender_pub, group_id, payload, ts, delivered)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, recipient, sender, senderPub, groupId, payload, ts, delivered ? 1 : 0],
    })),

  logCall: (id: string, caller: string, callee: string | null, groupId: string | null, video: boolean) =>
    db && safe(db.execute({
      sql: `INSERT INTO call_logs (id, caller, callee, group_id, video, ts, status) VALUES (?, ?, ?, ?, ?, ?, 'ringing')`,
      args: [id, caller, callee, groupId, video ? 1 : 0, Date.now()],
    })),

  // Most recent still-open (not ended) 1:1 call between this pair, in either
  // direction — used to correlate answer/decline/end back to the offer
  // without needing the client to carry an explicit call id.
  findOpenCall: async (a: string, b: string): Promise<{ id: string; status: string } | null> => {
    if (!db) return null
    const r = await db.execute({
      sql: `SELECT id, status FROM call_logs
            WHERE group_id IS NULL AND status != 'ended'
              AND ((caller=? AND callee=?) OR (caller=? AND callee=?))
            ORDER BY ts DESC LIMIT 1`,
      args: [a, b, b, a],
    })
    return r.rows[0] ? { id: String(r.rows[0].id), status: String(r.rows[0].status) } : null
  },

  findOpenGroupCall: async (groupId: string): Promise<{ id: string } | null> => {
    if (!db) return null
    const r = await db.execute({
      sql: `SELECT id FROM call_logs WHERE group_id=? AND status != 'ended' ORDER BY ts DESC LIMIT 1`,
      args: [groupId],
    })
    return r.rows[0] ? { id: String(r.rows[0].id) } : null
  },

  // Guarded to only fire on the true first answer — an ICE restart also
  // sends a plain call-answer with no way to tell it apart from the outside,
  // and re-stamping answered_at on every restart would skew duration.
  markCallAnswered: (id: string) =>
    db && safe(db.execute({ sql: `UPDATE call_logs SET status='answered', answered_at=? WHERE id=? AND status='ringing'`, args: [Date.now(), id] })),

  endCall: (id: string, outcome: 'completed' | 'missed' | 'declined') =>
    db && safe(db.execute({ sql: `UPDATE call_logs SET status=?, ended_at=? WHERE id=?`, args: [outcome, Date.now(), id] })),

  setCallRelay: (id: string, relay: 'p2p' | 'turn') =>
    db && safe(db.execute({ sql: `UPDATE call_logs SET relay=? WHERE id=? AND relay IS NULL`, args: [relay, id] })),

  markDelivered: (id: string, recipient: string) =>
    db && safe(db.execute({ sql: `UPDATE messages SET delivered=1 WHERE id=? AND recipient=?`, args: [id, recipient] })),

  backlog: async (recipient: string, limit = 500): Promise<MessageRow[]> => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT id, sender, sender_pub, group_id, payload, ts, delivered FROM messages
            WHERE recipient=? ORDER BY ts DESC LIMIT ?`,
      args: [recipient, limit],
    })
    return (r.rows as unknown as MessageRow[]).reverse()
  },

  undeliveredSenders: async (recipient: string): Promise<UndeliveredRow[]> => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT DISTINCT id, sender FROM messages WHERE recipient=? AND delivered=0`,
      args: [recipient],
    })
    return r.rows as unknown as UndeliveredRow[]
  },

  // peerId -> deletedAt, so a reconnecting client can re-hide history it
  // already cleared (the server can't filter this itself: a self-sent
  // message's "which conversation" tag lives inside the ciphertext, not a
  // DB column, so the client re-applies the cutoff after decrypting).
  getDeletedConversations: async (userId: string): Promise<DeletedConversationRow[]> => {
    if (!db) return []
    const r = await db.execute({ sql: `SELECT peer_id, deleted_at FROM deleted_conversations WHERE user_id=?`, args: [userId] })
    return r.rows as unknown as DeletedConversationRow[]
  },

  // Soft-delete: mark that a user has deleted their side of a conversation.
  // Messages are only purged from DB when BOTH sides have deleted.
  deleteConversation: async (userId: string, peerId: string): Promise<void> => {
    if (!db) return
    await db.execute({
      sql: `INSERT INTO deleted_conversations (user_id, peer_id, deleted_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id, peer_id) DO UPDATE SET deleted_at=excluded.deleted_at`,
      args: [userId, peerId, Date.now()]
    })
    // Check if the other side has also deleted
    const r = await db.execute({
      sql: `SELECT 1 FROM deleted_conversations WHERE user_id=? AND peer_id=?`,
      args: [peerId, userId]
    })
    if (r.rows.length > 0) {
      // Both sides deleted — purge messages between them
      await db.execute({
        sql: `DELETE FROM messages WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)`,
        args: [userId, peerId, peerId, userId]
      })
      await db.execute({ sql: `DELETE FROM deleted_conversations WHERE (user_id=? AND peer_id=?) OR (user_id=? AND peer_id=?)`, args: [userId, peerId, peerId, userId] })
    }
  },

  // ---- Privacy Settings ----
  getPrivacySettings: async (userId: string): Promise<PrivacySettingsRow> => {
    if (!db) return {
      user_id: userId,
      message_privacy: 'everyone',
      call_privacy: 'everyone',
      last_seen_privacy: 'everyone',
      online_privacy: 'everyone',
      avatar_privacy: 'everyone',
      bio_privacy: 'everyone',
    }
    const r = await db.execute({ sql: `SELECT * FROM privacy_settings WHERE user_id=?`, args: [userId] })
    return (r.rows[0] as unknown as PrivacySettingsRow) || {
      user_id: userId,
      message_privacy: 'everyone',
      call_privacy: 'everyone',
      last_seen_privacy: 'everyone',
      online_privacy: 'everyone',
      avatar_privacy: 'everyone',
      bio_privacy: 'everyone',
    }
  },

  savePrivacySettings: (userId: string, { message_privacy, call_privacy, last_seen_privacy, online_privacy, avatar_privacy, bio_privacy }: Omit<PrivacySettingsRow, 'user_id'>) =>
    db && safe(db.execute({
      sql: `INSERT INTO privacy_settings (user_id, message_privacy, call_privacy, last_seen_privacy, online_privacy, avatar_privacy, bio_privacy)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              message_privacy=excluded.message_privacy,
              call_privacy=excluded.call_privacy,
              last_seen_privacy=excluded.last_seen_privacy,
              online_privacy=excluded.online_privacy,
              avatar_privacy=excluded.avatar_privacy,
              bio_privacy=excluded.bio_privacy`,
      args: [userId, message_privacy, call_privacy, last_seen_privacy, online_privacy, avatar_privacy, bio_privacy]
    })),

  // ---- Reports ----
  createReport: (id: string, reporterId: string, reportedId: string, category: string, details: string | null) =>
    db && safe(db.execute({
      sql: `INSERT INTO user_reports (id, reporter_id, reported_id, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, reporterId, reportedId, category, details || null, Date.now()]
    })),

  resolveReport: (id: string) =>
    db && safe(db.execute({ sql: `UPDATE user_reports SET resolved=1 WHERE id=?`, args: [id] })),

  // ---- Notification Preferences ----
  getNotificationPrefs: async (userId: string): Promise<NotificationPrefsRow> => {
    const fallback: NotificationPrefsRow = { user_id: userId, messages: 1, calls: 1, contact_requests: 1, mentions: 1, group_activity: 1, announcements: 1 }
    if (!db) return fallback
    const r = await db.execute({ sql: `SELECT * FROM notification_preferences WHERE user_id=?`, args: [userId] })
    return (r.rows[0] as unknown as NotificationPrefsRow) || fallback
  },

  saveNotificationPrefs: (userId: string, { messages, calls, contact_requests, mentions, group_activity, announcements }: { messages: boolean; calls: boolean; contact_requests: boolean; mentions: boolean; group_activity: boolean; announcements: boolean }) =>
    db && safe(db.execute({
      sql: `INSERT INTO notification_preferences (user_id, messages, calls, contact_requests, mentions, group_activity, announcements)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              messages=excluded.messages, calls=excluded.calls,
              contact_requests=excluded.contact_requests, mentions=excluded.mentions,
              group_activity=excluded.group_activity, announcements=excluded.announcements`,
      args: [userId, messages ? 1 : 0, calls ? 1 : 0, contact_requests ? 1 : 0, mentions ? 1 : 0, group_activity ? 1 : 0, announcements ? 1 : 0]
    })),

  // ---- Sessions ----
  createSession: (id: string, userId: string, socketId: string, ip: string | null, userAgent: string | null, deviceHint: string | null, via: 'passkey' | 'passwordless' = 'passwordless') =>
    db && safe(db.execute({
      sql: `INSERT INTO user_sessions (id, user_id, socket_id, ip, user_agent, device_hint, logged_in_at, last_active, via)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, userId, socketId, ip || null, userAgent || null, deviceHint || null, Date.now(), Date.now(), via]
    })),

  touchSession: (sessionId: string) =>
    db && safe(db.execute({ sql: `UPDATE user_sessions SET last_active=? WHERE id=?`, args: [Date.now(), sessionId] })),

  getSessions: async (userId: string): Promise<SessionRow[]> => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT id, socket_id, ip, user_agent, device_hint, logged_in_at, last_active FROM user_sessions
            WHERE user_id=? AND revoked=0 ORDER BY last_active DESC LIMIT 20`,
      args: [userId]
    })
    return r.rows as unknown as SessionRow[]
  },

  // Every login ever recorded (active or since ended), newest first — the
  // same user_sessions rows getSessions filters to revoked=0, just unfiltered.
  getLoginHistory: async (userId: string, limit = 20): Promise<LoginHistoryRow[]> => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT id, ip, device_hint, logged_in_at, last_active, revoked FROM user_sessions
            WHERE user_id=? ORDER BY logged_in_at DESC LIMIT ?`,
      args: [userId, limit]
    })
    return r.rows as unknown as LoginHistoryRow[]
  },

  revokeSession: (sessionId: string, userId: string) =>
    db && safe(db.execute({
      sql: `UPDATE user_sessions SET revoked=1 WHERE id=? AND user_id=?`,
      args: [sessionId, userId]
    })),

  revokeAllSessionsExcept: (userId: string, exceptSessionId: string) =>
    db && safe(db.execute({
      sql: `UPDATE user_sessions SET revoked=1 WHERE user_id=? AND id != ?`,
      args: [userId, exceptSessionId]
    })),

  // ---- Passkeys ----
  savePasskey: (id: string, userId: string, credentialId: string, publicKey: string, counter: number, deviceType: string | undefined, backedUp: boolean, transports: string[] | undefined) =>
    db && safe(db.execute({
      sql: `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, backed_up, transports, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, userId, credentialId, publicKey, counter, deviceType || null, backedUp ? 1 : 0, transports ? JSON.stringify(transports) : null, Date.now()]
    })),

  getPasskeysByUser: async (userId: string): Promise<PasskeyCredentialRow[]> => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT * FROM passkey_credentials WHERE user_id=? ORDER BY created_at DESC`,
      args: [userId]
    })
    return r.rows as unknown as PasskeyCredentialRow[]
  },

  getPasskeyByCredentialId: async (credentialId: string): Promise<PasskeyCredentialRow | null> => {
    if (!db) return null
    const r = await db.execute({ sql: `SELECT * FROM passkey_credentials WHERE credential_id=?`, args: [credentialId] })
    return (r.rows[0] as unknown as PasskeyCredentialRow) || null
  },

  updatePasskeyCounter: (credentialId: string, counter: number) =>
    db && safe(db.execute({
      sql: `UPDATE passkey_credentials SET counter=?, last_used=? WHERE credential_id=?`,
      args: [counter, Date.now(), credentialId]
    })),

  deletePasskey: (credentialId: string, userId: string) =>
    db && safe(db.execute({
      sql: `DELETE FROM passkey_credentials WHERE credential_id=? AND user_id=?`,
      args: [credentialId, userId]
    })),

  // ---- Push subscriptions ----
  savePushSubscription: (id: string, userId: string, endpoint: string, p256dh: string, auth: string) =>
    db && safe(db.execute({
      sql: `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`,
      args: [id, userId, endpoint, p256dh, auth, Date.now()]
    })),

  getPushSubscriptions: async (userId: string): Promise<PushSubscriptionRow[]> => {
    if (!db) return []
    const r = await db.execute({ sql: `SELECT * FROM push_subscriptions WHERE user_id=?`, args: [userId] })
    return r.rows as unknown as PushSubscriptionRow[]
  },

  deletePushSubscription: (endpoint: string) =>
    db && safe(db.execute({ sql: `DELETE FROM push_subscriptions WHERE endpoint=?`, args: [endpoint] })),

  // ---- Push delivery log (notification analytics) ----
  logPush: (id: string, userId: string, tag: string | undefined, ok: boolean, expired: boolean) =>
    db && safe(db.execute({
      sql: `INSERT INTO push_log (id, user_id, tag, ok, expired, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, userId, tag || null, ok ? 1 : 0, expired ? 1 : 0, Date.now()],
    })),

  // Reported by the service worker's notificationclick — a real per-push
  // read receipt, not a guess. See public/sw.js + the push-opened socket event.
  markPushOpened: (id: string) =>
    db && safe(db.execute({ sql: `UPDATE push_log SET opened_at=? WHERE id=? AND opened_at IS NULL`, args: [Date.now(), id] })),

  // ---- Failed logins (security dashboard) ----
  logFailedLogin: (id: string, clientId: string | null, ip: string | null, reason: string) =>
    db && safe(db.execute({
      sql: `INSERT INTO failed_logins (id, client_id, ip, reason, ts) VALUES (?, ?, ?, ?, ?)`,
      args: [id, clientId, ip, reason, Date.now()],
    })),

  countRecentFailedLogins: async (ip: string, sinceMs: number): Promise<number> => {
    if (!db || !ip) return 0
    const r = await db.execute({ sql: `SELECT COUNT(*) c FROM failed_logins WHERE ip=? AND ts > ?`, args: [ip, Date.now() - sinceMs] })
    return Number(r.rows[0]?.c ?? 0)
  },

  suspiciousIps: async (sinceMs = 3_600_000, minFails = 3): Promise<{ ip: string; count: number }[]> => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT ip, COUNT(*) c FROM failed_logins WHERE ts > ? AND ip IS NOT NULL GROUP BY ip HAVING c >= ? ORDER BY c DESC LIMIT 20`,
      args: [Date.now() - sinceMs, minFails],
    })
    return r.rows.map((row) => ({ ip: String(row.ip), count: Number(row.c) }))
  },

  // ---- Admin audit log ----
  logAdminAction: (id: string, action: string, target: string | null, detail: string | null, ip: string | null) =>
    db && safe(db.execute({
      sql: `INSERT INTO admin_audit_log (id, action, target, detail, ip, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, action, target, detail, ip, Date.now()],
    })),

  getAuditLog: async (limit = 100): Promise<{ id: string; action: string; target: string | null; detail: string | null; ip: string | null; ts: number }[]> => {
    if (!db) return []
    const r = await db.execute({ sql: `SELECT * FROM admin_audit_log ORDER BY ts DESC LIMIT ?`, args: [limit] })
    return r.rows.map((row) => ({
      id: String(row.id), action: String(row.action), target: row.target as string | null,
      detail: row.detail as string | null, ip: row.ip as string | null, ts: Number(row.ts),
    }))
  },

  // ---- User security events (audit trail) ----
  logSecurityEvent: (id: string, userId: string, event: string, detail: string | null, ip: string | null) =>
    db && safe(db.execute({
      sql: `INSERT INTO security_events (id, user_id, event, detail, ip, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, userId, event, detail, ip, Date.now()],
    })),

  // ---- Feature flags ----
  getFeatureFlags: async (): Promise<Record<string, boolean>> => {
    if (!db) return {}
    const r = await db.execute(`SELECT key, enabled FROM feature_flags`)
    return Object.fromEntries(r.rows.map((row) => [row.key, !!row.enabled]))
  },

  setFeatureFlag: (key: string, enabled: boolean) =>
    db && safe(db.execute({
      sql: `INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`,
      args: [key, enabled ? 1 : 0, Date.now()],
    })),

  // ---- System config ----
  getSystemConfig: async (): Promise<Record<string, string>> => {
    if (!db) return {}
    const r = await db.execute(`SELECT key, value FROM system_config`)
    return Object.fromEntries(r.rows.map((row) => [row.key, String(row.value)]))
  },

  setSystemConfig: (key: string, value: string) =>
    db && safe(db.execute({
      sql: `INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      args: [key, value, Date.now()],
    })),

  // ---- Moderation: suspend ----
  setSuspended: (userId: string, suspended: boolean) =>
    db && safe(db.execute({ sql: `UPDATE users SET suspended=? WHERE id=?`, args: [suspended ? 1 : 0, userId] })),

  isSuspended: async (userId: string): Promise<boolean> => {
    if (!db) return false
    const r = await db.execute({ sql: `SELECT suspended FROM users WHERE id=?`, args: [userId] })
    return !!r.rows[0]?.suspended
  },
}
