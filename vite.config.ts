import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { articlePlugin } from './build/article.mjs'

export default defineConfig({
  plugins: [articlePlugin(), vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  base: '/',
  appType: 'mpa',
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        how: fileURLToPath(new URL('./how/index.html', import.meta.url)),
      },
    },
  },
})
