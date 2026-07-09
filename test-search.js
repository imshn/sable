import { createClient } from '@libsql/client'

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

async function run() {
  const q = 'Saziya'
  const like = `%${q}%`
  try {
    const res = await db.execute({
      sql: `SELECT id, name, username, avatar FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 50`,
      args: [like, like]
    })
    console.log("Success:", res.rows)
  } catch (e) {
    console.log("Error:", e.message)
  }
}
run()
