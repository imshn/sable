// Turso (libSQL) persistence. Everything stored is either public-by-design
// (names, public keys, group rosters) or ciphertext the server cannot read.
// Without TURSO_DATABASE_URL the relay runs memory-only, exactly as before.
import { createClient } from '@libsql/client'

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

export const db = url ? createClient({ url, authToken }) : null

export async function migrate() {
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
      mentions INTEGER NOT NULL DEFAULT 1
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
    `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)`
  ], 'write')

  // Safely add columns using a helper that swallows "column already exists" errors
  const addCol = async (sql) => { try { await db.execute(sql) } catch (e) { /* ignores if exists */ } }
  await addCol("ALTER TABLE users ADD COLUMN username TEXT")
  await addCol("ALTER TABLE users ADD COLUMN avatar TEXT")
  await addCol("ALTER TABLE users ADD COLUMN bio TEXT")
  await addCol("ALTER TABLE users ADD COLUMN created_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN updated_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
  await addCol("ALTER TABLE privacy_settings ADD COLUMN bio_privacy TEXT NOT NULL DEFAULT 'everyone'")

  // Fallback for existing users and index
  await db.execute("UPDATE users SET username = 'user_' || substr(id, 1, 6) WHERE username IS NULL")
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")

  console.log('turso: migrated')
}

// fire-and-forget writes — a slow or failing DB must never break live relaying
const safe = (p) => p.catch((e) => console.error('db error', e.message))

export const store = {
  // ---- Users ----
  upsertUser: (id, name, pubkey, username = null) => {
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

  checkUsernameAvailable: async (username, currentUserId) => {
    if (!db) return true
    const r = await db.execute({ sql: `SELECT id FROM users WHERE username = ? AND deleted = 0`, args: [username] })
    if (r.rows.length === 0) return true
    return r.rows[0].id === currentUserId
  },

  updateProfile: async (id, { name, username, bio, avatar }) => {
    if (!db) return false
    try {
      const r = await db.execute({
        sql: `UPDATE users SET name=?, username=?, bio=?, avatar=?, updated_at=? WHERE id=?`,
        args: [name, username, bio, avatar, Date.now(), id]
      })
      return r.rowsAffected > 0
    } catch (e) {
      console.error('db update profile error:', e.message)
      return false
    }
  },

  getUser: async (id) => {
    if (!db) return null
    const r = await db.execute({ sql: `SELECT id, name, username, bio, avatar, pubkey, created_at, updated_at, last_seen FROM users WHERE id=? AND deleted=0`, args: [id] })
    return r.rows[0] || null
  },

  touchUser: (id) =>
    db && safe(db.execute({ sql: `UPDATE users SET last_seen=? WHERE id=?`, args: [Date.now(), id] })),

  allUsers: async () => {
    if (!db) return []
    const r = await db.execute(`SELECT id, name, username, avatar, pubkey, last_seen FROM users WHERE deleted=0 ORDER BY last_seen DESC LIMIT 200`)
    return r.rows
  },

  searchUsers: async (query, currentUserId, limit = 50) => {
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
    return r.rows
  },

  // Soft-delete account: anonymize user record, keep message ciphertext for other participants
  deleteAccount: async (userId) => {
    if (!db) return
    const anon = `deleted_${userId.slice(0, 8)}`
    await db.execute({
      sql: `UPDATE users SET name=?, username=?, bio='', avatar='', updated_at=?, deleted=1 WHERE id=?`,
      args: [anon, anon, Date.now(), userId]
    })
    // Remove contacts and invitations
    await db.execute({ sql: `DELETE FROM contacts WHERE requester_id=? OR recipient_id=?`, args: [userId, userId] })
    await db.execute({ sql: `DELETE FROM invitations WHERE creator_id=?`, args: [userId] })
    await db.execute({ sql: `DELETE FROM privacy_settings WHERE user_id=?`, args: [userId] })
    await db.execute({ sql: `DELETE FROM notification_preferences WHERE user_id=?`, args: [userId] })
    // Revoke all sessions
    await db.execute({ sql: `UPDATE user_sessions SET revoked=1 WHERE user_id=?`, args: [userId] })
  },

  // ---- Contacts ----
  upsertContact: (requesterId, recipientId, status) =>
    db && safe(db.execute({
      sql: `INSERT INTO contacts (requester_id, recipient_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(requester_id, recipient_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`,
      args: [requesterId, recipientId, status, Date.now(), Date.now()]
    })),

  getContacts: async (userId) => {
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
    return r.rows
  },

  deleteContact: (requesterId, recipientId) =>
    db && safe(db.execute({
      sql: `DELETE FROM contacts WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)`,
      args: [requesterId, recipientId, recipientId, requesterId]
    })),

  // ---- Invitations ----
  createInvite: (id, code, creatorId, expiresAt) =>
    db && safe(db.execute({
      sql: `INSERT INTO invitations (id, code, creator_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      args: [id, code, creatorId, Date.now(), expiresAt]
    })),

  getInvite: async (code) => {
    if (!db) return null
    const r = await db.execute({
      sql: `SELECT i.*, u.name as creator_name, u.username as creator_username, u.avatar as creator_avatar
            FROM invitations i
            JOIN users u ON i.creator_id = u.id
            WHERE i.code = ? AND u.deleted = 0`,
      args: [code]
    })
    return r.rows[0]
  },

  // ---- Groups ----
  saveGroup: (id, name, owner, memberIds) =>
    db && safe((async () => {
      await db.execute({ sql: `INSERT OR REPLACE INTO groups (id, name, owner) VALUES (?, ?, ?)`, args: [id, name, owner] })
      await db.execute({ sql: `DELETE FROM group_members WHERE group_id=?`, args: [id] })
      for (const m of memberIds) {
        await db.execute({ sql: `INSERT OR IGNORE INTO group_members (group_id, member_id) VALUES (?, ?)`, args: [id, m] })
      }
    })()),

  deleteGroup: (id) =>
    db && safe(db.batch([
      { sql: `DELETE FROM groups WHERE id=?`, args: [id] },
      { sql: `DELETE FROM group_members WHERE group_id=?`, args: [id] },
    ], 'write')),

  loadGroups: async () => {
    if (!db) return []
    const gs = await db.execute(`SELECT id, name, owner FROM groups`)
    const ms = await db.execute(`SELECT group_id, member_id FROM group_members`)
    return gs.rows.map((g) => ({
      ...g,
      members: ms.rows.filter((m) => m.group_id === g.id).map((m) => m.member_id),
    }))
  },

  // ---- Messages ----
  saveMessage: (id, recipient, sender, senderPub, groupId, payload, ts, delivered) =>
    db && safe(db.execute({
      sql: `INSERT OR IGNORE INTO messages (id, recipient, sender, sender_pub, group_id, payload, ts, delivered)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, recipient, sender, senderPub, groupId, payload, ts, delivered ? 1 : 0],
    })),

  markDelivered: (id, recipient) =>
    db && safe(db.execute({ sql: `UPDATE messages SET delivered=1 WHERE id=? AND recipient=?`, args: [id, recipient] })),

  backlog: async (recipient, limit = 500) => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT id, sender, sender_pub, group_id, payload, ts, delivered FROM messages
            WHERE recipient=? ORDER BY ts DESC LIMIT ?`,
      args: [recipient, limit],
    })
    return r.rows.reverse()
  },

  undeliveredSenders: async (recipient) => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT DISTINCT id, sender FROM messages WHERE recipient=? AND delivered=0`,
      args: [recipient],
    })
    return r.rows
  },

  // peerId -> deletedAt, so a reconnecting client can re-hide history it
  // already cleared (the server can't filter this itself: a self-sent
  // message's "which conversation" tag lives inside the ciphertext, not a
  // DB column, so the client re-applies the cutoff after decrypting).
  getDeletedConversations: async (userId) => {
    if (!db) return []
    const r = await db.execute({ sql: `SELECT peer_id, deleted_at FROM deleted_conversations WHERE user_id=?`, args: [userId] })
    return r.rows
  },

  // Soft-delete: mark that a user has deleted their side of a conversation.
  // Messages are only purged from DB when BOTH sides have deleted.
  deleteConversation: async (userId, peerId) => {
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
  getPrivacySettings: async (userId) => {
    if (!db) return null
    const r = await db.execute({ sql: `SELECT * FROM privacy_settings WHERE user_id=?`, args: [userId] })
    return r.rows[0] || {
      user_id: userId,
      message_privacy: 'everyone',
      call_privacy: 'everyone',
      last_seen_privacy: 'everyone',
      online_privacy: 'everyone',
      avatar_privacy: 'everyone',
      bio_privacy: 'everyone',
    }
  },

  savePrivacySettings: (userId, { message_privacy, call_privacy, last_seen_privacy, online_privacy, avatar_privacy, bio_privacy }) =>
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
  createReport: (id, reporterId, reportedId, category, details) =>
    db && safe(db.execute({
      sql: `INSERT INTO user_reports (id, reporter_id, reported_id, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, reporterId, reportedId, category, details || null, Date.now()]
    })),

  // ---- Notification Preferences ----
  getNotificationPrefs: async (userId) => {
    if (!db) return null
    const r = await db.execute({ sql: `SELECT * FROM notification_preferences WHERE user_id=?`, args: [userId] })
    return r.rows[0] || { user_id: userId, messages: 1, calls: 1, contact_requests: 1, mentions: 1 }
  },

  saveNotificationPrefs: (userId, { messages, calls, contact_requests, mentions }) =>
    db && safe(db.execute({
      sql: `INSERT INTO notification_preferences (user_id, messages, calls, contact_requests, mentions)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              messages=excluded.messages, calls=excluded.calls,
              contact_requests=excluded.contact_requests, mentions=excluded.mentions`,
      args: [userId, messages ? 1 : 0, calls ? 1 : 0, contact_requests ? 1 : 0, mentions ? 1 : 0]
    })),

  // ---- Sessions ----
  createSession: (id, userId, socketId, ip, userAgent, deviceHint) =>
    db && safe(db.execute({
      sql: `INSERT INTO user_sessions (id, user_id, socket_id, ip, user_agent, device_hint, logged_in_at, last_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, userId, socketId, ip || null, userAgent || null, deviceHint || null, Date.now(), Date.now()]
    })),

  touchSession: (sessionId) =>
    db && safe(db.execute({ sql: `UPDATE user_sessions SET last_active=? WHERE id=?`, args: [Date.now(), sessionId] })),

  getSessions: async (userId) => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT id, socket_id, ip, user_agent, device_hint, logged_in_at, last_active FROM user_sessions
            WHERE user_id=? AND revoked=0 ORDER BY last_active DESC LIMIT 20`,
      args: [userId]
    })
    return r.rows
  },

  revokeSession: (sessionId, userId) =>
    db && safe(db.execute({
      sql: `UPDATE user_sessions SET revoked=1 WHERE id=? AND user_id=?`,
      args: [sessionId, userId]
    })),

  revokeAllSessionsExcept: (userId, exceptSessionId) =>
    db && safe(db.execute({
      sql: `UPDATE user_sessions SET revoked=1 WHERE user_id=? AND id != ?`,
      args: [userId, exceptSessionId]
    })),

  // ---- Passkeys ----
  savePasskey: (id, userId, credentialId, publicKey, counter, deviceType, backedUp, transports) =>
    db && safe(db.execute({
      sql: `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, backed_up, transports, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, userId, credentialId, publicKey, counter, deviceType || null, backedUp ? 1 : 0, transports ? JSON.stringify(transports) : null, Date.now()]
    })),

  getPasskeysByUser: async (userId) => {
    if (!db) return []
    const r = await db.execute({
      sql: `SELECT * FROM passkey_credentials WHERE user_id=? ORDER BY created_at DESC`,
      args: [userId]
    })
    return r.rows
  },

  getPasskeyByCredentialId: async (credentialId) => {
    if (!db) return null
    const r = await db.execute({ sql: `SELECT * FROM passkey_credentials WHERE credential_id=?`, args: [credentialId] })
    return r.rows[0] || null
  },

  updatePasskeyCounter: (credentialId, counter) =>
    db && safe(db.execute({
      sql: `UPDATE passkey_credentials SET counter=?, last_used=? WHERE credential_id=?`,
      args: [counter, Date.now(), credentialId]
    })),

  deletePasskey: (credentialId, userId) =>
    db && safe(db.execute({
      sql: `DELETE FROM passkey_credentials WHERE credential_id=? AND user_id=?`,
      args: [credentialId, userId]
    })),

  // ---- Push subscriptions ----
  savePushSubscription: (id, userId, endpoint, p256dh, auth) =>
    db && safe(db.execute({
      sql: `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`,
      args: [id, userId, endpoint, p256dh, auth, Date.now()]
    })),

  getPushSubscriptions: async (userId) => {
    if (!db) return []
    const r = await db.execute({ sql: `SELECT * FROM push_subscriptions WHERE user_id=?`, args: [userId] })
    return r.rows
  },

  deletePushSubscription: (endpoint) =>
    db && safe(db.execute({ sql: `DELETE FROM push_subscriptions WHERE endpoint=?`, args: [endpoint] })),
}
