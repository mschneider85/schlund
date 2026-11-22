import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import wasm from 'vite-plugin-wasm';

// Erzeugt beim Build einen Service Worker mit vollständiger Precache-Liste,
// damit das Spiel nach dem ersten Besuch komplett offline läuft.
function serviceWorker(): Plugin {
  return {
    name: 'schlund-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const publicFiles = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/icon.svg', 'icons/apple-touch-icon.png'];
      const precache = ['./', ...files, ...publicFiles].map((f) => (f === './' ? f : './' + f));
      const version = Date.now().toString(36);
      const src = readFileSync('src/sw-template.js', 'utf8')
        .replace('__PRECACHE__', JSON.stringify(precache))
        .replace('__VERSION__', version);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

// Netz-Kennung: nur Spieler mit identischer Spiellogik (gleiche Stadt aus gleichem Seed) treffen sich
const netId = createHash('sha1')
  .update(['city', 'objects', 'world', 'hole', 'game', 'net'].map((f) => readFileSync(`src/${f}.ts`, 'utf8')).join())
  .digest('hex').slice(0, 10);

export default defineConfig({
  base: './',
  define: { __NET_ID__: JSON.stringify(netId) },
  plugins: [wasm(), serviceWorker()],
  optimizeDeps: { exclude: ['@dimforge/rapier3d-simd'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
