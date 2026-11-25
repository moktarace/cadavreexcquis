import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

// Sous-chemin de déploiement (ex. « /mon-depot/ » sur GitHub Pages); « / » par défaut.
const base = process.env.VITE_BASE ?? '/';

// SHA réellement compilé (GitHub Actions, sinon git local): affiché dans l'aide de Survivor pour vérifier ce qui est déployé.
function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return dirty ? `${sha}+local` : sha;
  } catch {
    return 'inconnu';
  }
}

export default defineConfig({
  base,
  define: { __BUILD_COMMIT__: JSON.stringify(commit()), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  plugins: [
    react(),
    // injectManifest: le service worker est écrit à la main (src/sw.ts) pour accueillir Web Push en phase D.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        id: base,
        name: 'Cadavre Exquis',
        short_name: 'Cadavre Exquis',
        description: 'Des histoires en quatre cases, dessinées à plusieurs, chacun à son rythme.',
        lang: 'fr',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        background_color: '#fff6dc',
        theme_color: '#8c6bd6',
        categories: ['games', 'entertainment'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'] },
      devOptions: { enabled: false },
    }),
  ],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'supabase/functions/**/*.test.ts'] },
});
