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
    `CREATE TABLE IF NOT EXISTS privacy_settings (
      user_id TEXT PRIMARY KEY,
      message_privacy TEXT,
      call_privacy TEXT,
      last_seen_privacy TEXT,
      online_privacy TEXT,
      avatar_privacy TEXT
    )`
  ], 'write')

  // Safely add columns to users table
  const addCol = async (sql) => { try { await db.execute(sql) } catch (e) { /* ignores if exists */ } }
  await addCol("ALTER TABLE users ADD COLUMN username TEXT")
  await addCol("ALTER TABLE users ADD COLUMN avatar TEXT")
  await addCol("ALTER TABLE users ADD COLUMN bio TEXT")
  await addCol("ALTER TABLE users ADD COLUMN created_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN updated_at INTEGER")

  // Fallback for existing users and index
  await db.execute("UPDATE users SET username = 'user_' || substr(id, 1, 6) WHERE username IS NULL")
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")

  console.log('turso: migrated')
}

// fire-and-forget writes — a slow or failing DB must never break live relaying
const safe = (p) => p.catch((e) => console.error('db error', e.message))

export const store = {
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
    const r = await db.execute({ sql: `SELECT id FROM users WHERE username = ?`, args: [username] })
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
    const r = await db.execute({ sql: `SELECT id, name, username, bio, avatar, pubkey, created_at, updated_at, last_seen FROM users WHERE id=?`, args: [id] })
    return r.rows[0] || null
  },

  touchUser: (id) =>
    db && safe(db.execute({ sql: `UPDATE users SET last_seen=? WHERE id=?`, args: [Date.now(), id] })),

  allUsers: async () => {
    if (!db) return []
    const r = await db.execute(`SELECT id, name, username, avatar, pubkey, last_seen FROM users ORDER BY last_seen DESC LIMIT 200`)
    return r.rows
  },

  searchUsers: async (query, currentUserId, limit = 50) => {
    if (!db || !query) return []
    const like = `%${query}%`
    const r = await db.execute({
      sql: `SELECT id, name, username, avatar FROM users 
            WHERE (username LIKE ? OR name LIKE ?)
            AND id != ?
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

  // Contact Management
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
            WHERE c.requester_id = ? OR c.recipient_id = ?`,
      args: [userId, userId]
    })
    return r.rows
  },

  deleteContact: (requesterId, recipientId) =>
    db && safe(db.execute({
      sql: `DELETE FROM contacts WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)`,
      args: [requesterId, recipientId, recipientId, requesterId]
    })),

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
            WHERE i.code = ?`,
      args: [code]
    })
    return r.rows[0]
  },

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
}
