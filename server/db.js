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
    // one row per recipient; payload is AES-GCM ciphertext sealed for that
    // recipient only. sender_pub lets the recipient re-derive the shared key
    // even after a restart.
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
  ], 'write')
  console.log('turso: migrated')
}

// fire-and-forget writes — a slow or failing DB must never break live relaying
const safe = (p) => p.catch((e) => console.error('db error', e.message))

export const store = {
  upsertUser: (id, name, pubkey) =>
    db && safe(db.execute({
      sql: `INSERT INTO users (id, name, pubkey, last_seen) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, pubkey=excluded.pubkey, last_seen=excluded.last_seen`,
      args: [id, name, pubkey, Date.now()],
    })),

  touchUser: (id) =>
    db && safe(db.execute({ sql: `UPDATE users SET last_seen=? WHERE id=?`, args: [Date.now(), id] })),

  allUsers: async () => {
    if (!db) return []
    const r = await db.execute(`SELECT id, name, pubkey, last_seen FROM users ORDER BY last_seen DESC LIMIT 200`)
    return r.rows
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
