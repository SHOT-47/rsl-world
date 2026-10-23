import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { sourcemap: process.env.NODE_ENV !== 'production' }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { sourcemap: process.env.NODE_ENV !== 'production' }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react()],
    server: { host: '127.0.0.1' },
    build: { sourcemap: process.env.NODE_ENV !== 'production' }
  }
})
