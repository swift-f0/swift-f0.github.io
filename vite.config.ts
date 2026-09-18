import { fileURLToPath, URL } from 'node:url'

import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

function preloadAssets(): Plugin {
  return {
    name: 'preload-assets',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const links: string[] = []
      for (const file of Object.keys(bundle)) {
        const href = `/${file}`
        if (/onnx-worker.*\.js$/.test(file)) links.push(`<link rel="modulepreload" href="${href}">`)
        else if (/ort-wasm.*\.mjs$/.test(file)) links.push(`<link rel="modulepreload" href="${href}">`)
        else if (file.endsWith('.wasm') || file.endsWith('.onnx')) links.push(`<link rel="preload" href="${href}" as="fetch" crossorigin>`)
        else if (file.endsWith('.woff2')) links.push(`<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`)
      }
      const html = bundle['index.html']
      if (html && html.type === 'asset' && typeof html.source === 'string') {
        html.source = html.source.replace('</head>', `    ${links.join('\n    ')}\n  </head>`)
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    preloadAssets(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: process.env.NODE_ENV === 'production' ? '/' : '/',
})
