import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = process.env.VITE_BASE_URL ?? '/'

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Mapa Nueva York',
        short_name: 'NYC Map',
        description: 'Mapa interactivo con puntos de interés, GPS y rutas por días',
        theme_color: '#070b12',
        background_color: '#070b12',
        display: 'standalone',
        lang: 'es',
        start_url: base,
        icons: [
          {
            src: '/favicon.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,png,webp,json}'],
      },
    }),
  ],
})
