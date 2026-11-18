import { createApp } from './app.js'
import { pool, waitForDatabase, migrate } from './db.js'

const PORT = Number(process.env.PORT ?? 3000)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (e.g. postgres://gym:<password>@gym-db:5432/gym)')
  process.exit(1)
}

await waitForDatabase()
await migrate()

const server = createApp().listen(PORT, () => console.log(`gym-api listening on port ${PORT}`))

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
