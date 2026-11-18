import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// One codebase, two builds:
//   npm run build          → data in IndexedDB on the device (the Android app)
//   npm run build:server   → data on the gym server (PostgreSQL), for the self-hosted version
// In "server" mode every import of src/db/dal.js is swapped for src/db/dal.api.js,
// so none of the pages need to know where the data lives.
const dalApi = fileURLToPath(new URL('./src/db/dal.api.js', import.meta.url))

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: mode === 'server' ? [{ find: /^.*\/db\/dal\.js$/, replacement: dalApi }] : [],
  },
  server: {
    // `npm run dev:server`: the dev server forwards /api to a gym server on this machine
    proxy: { '/api': 'http://localhost:3000' },
  },
}))
