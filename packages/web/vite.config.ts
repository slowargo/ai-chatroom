import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// A /mnt/* checkout is a Windows drive mounted into WSL2 over 9p, where inotify file-watch events
// don't fire — vite would otherwise keep serving the transform cached at startup and never hot
// reload edits. Enable polling (some CPU cost) only there, so native Linux/mac checkouts pay
// nothing; CHOKIDAR_USEPOLLING=1 forces it on regardless.
const projectDir = dirname(fileURLToPath(import.meta.url))
const usePolling = process.env.CHOKIDAR_USEPOLLING === '1' || projectDir.startsWith('/mnt/')

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
  },
})
