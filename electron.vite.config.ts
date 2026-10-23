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
    // main/index.ts resolves this exact path in development and in app.asar.
    // Pin the artifact name instead of relying on package.json "type" inference.
    build: {
      sourcemap: process.env.NODE_ENV !== 'production',
      rollupOptions: {
        output: {
          entryFileNames: 'index.js',
          chunkFileNames: '[name]-[hash].js'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react()],
    server: { host: '127.0.0.1' },
    build: { sourcemap: process.env.NODE_ENV !== 'production' }
  }
})
