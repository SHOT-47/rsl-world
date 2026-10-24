import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  preview: { host: '0.0.0.0', port: 4173 },
  build: { outDir: resolve(root, 'dist'), emptyOutDir: true, sourcemap: false }
})
