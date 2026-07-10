import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
      '/preview': { target: 'http://localhost:3001' },
      '/turn': { target: 'http://localhost:3001' },
      '/api': { target: 'http://localhost:3001' },
      '/vapid-key': { target: 'http://localhost:3001' },
      '/config': { target: 'http://localhost:3001' },
      // note the trailing slash+content requirement — a bare "/admin" is the
      // client-side dashboard *route* (served by the SPA), only "/admin/..."
      // sub-paths are the backend API
      '^/admin/.+': { target: 'http://localhost:3001' },
    },
  },
})
