import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Without this, Vite binds only to the IPv6 loopback ([::1]) on this
    // machine - "http://localhost:5173" still works (localhost resolves to
    // ::1 here), but "http://127.0.0.1:5173" (what start.sh's health check
    // and printed URL both use) gets connection-refused. Pin to IPv4 so both
    // hostnames actually reach the server.
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? '5000'}`,
        changeOrigin: true,
      },
    },
  },
})
