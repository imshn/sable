import { createClient } from '@libsql/client'

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

async function run() {
  const addCol = async (sql) => {
    try {
      await db.execute(sql)
      console.log('Success:', sql)
    } catch (e) {
      console.log('Failed:', sql, e.message)
    }
  }

  await addCol("ALTER TABLE users ADD COLUMN username TEXT")
  await addCol("ALTER TABLE users ADD COLUMN avatar TEXT")
  await addCol("ALTER TABLE users ADD COLUMN bio TEXT")
  await addCol("ALTER TABLE users ADD COLUMN created_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN updated_at INTEGER")
  await addCol("ALTER TABLE users ADD COLUMN privacy_settings TEXT") // wait, the privacy_settings is a separate table.
  try {
    await db.execute("UPDATE users SET username = 'user_' || substr(id, 1, 6) WHERE username IS NULL")
  } catch (e) { console.log(e.message) }
  try {
    await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")
  } catch (e) { console.log(e.message) }
  console.log("Done")
}
run()
