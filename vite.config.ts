import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { createApi } from './server/api.mjs';
import { loadConfig } from './server/config.mjs';

/** Base partagée (/api) servie aussi par « npm run dev » et « npm run preview ». */
function runbpmApi(): Plugin {
  const config = loadConfig();
  const api = createApi({ dataFile: config.dataFile, navidromeUrl: config.navidromeUrl });
  const mount = (middlewares: Connect.Server): void => {
    middlewares.use((req, res, next) => void api.handle(req, res, next));
  };
  return {
    name: 'runbpm-api',
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}

export default defineConfig({
  // Chemins relatifs : le build fonctionne aussi dans un sous-dossier (ex. GitHub Pages).
  base: './',
  plugins: [runbpmApi()],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
