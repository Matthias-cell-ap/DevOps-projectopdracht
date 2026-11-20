import { createApp } from './app.js'
import { pool, waitForDatabase, migrate } from './db.js'
import { isValidUserName } from './tables.js'

const PORT = Number(process.env.PORT ?? 3000)
const { GYM_DEFAULT_USER, GYM_MIGRATE_OWNER } = process.env

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (e.g. postgres://gym:<password>@gym-db:5432/gym)')
  process.exit(1)
}
for (const [name, value] of Object.entries({ GYM_DEFAULT_USER, GYM_MIGRATE_OWNER })) {
  if (value !== undefined && !isValidUserName(value)) {
    console.error(`${name} must be a simple user name (letters, digits, . _ @ -)`)
    process.exit(1)
  }
}
if (GYM_DEFAULT_USER) console.warn(`GYM_DEFAULT_USER is set: requests without login act as "${GYM_DEFAULT_USER}". Only for local development!`)

await waitForDatabase()
try {
  await migrate({ migrateOwner: GYM_MIGRATE_OWNER })
} catch (err) {
  console.error(`Cannot start: ${err.message}`)
  process.exit(1)
}

const server = createApp({ defaultUser: GYM_DEFAULT_USER })
  .listen(PORT, () => console.log(`gym-api listening on port ${PORT}`))

// `docker stop` sends SIGTERM. Node running as PID 1 in a container ignores it unless we
// handle it — Docker would then wait 10 s and kill the process mid-request.
// Here: stop taking new requests, finish the running ones, close the database pool, exit.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    server.close(async () => {
      await pool.end()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
