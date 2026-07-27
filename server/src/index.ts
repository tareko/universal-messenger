import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { config, checkConfig } from './config.js';
import { initDb } from './store/db.js';
import { api, checkAuth } from './routes/api.js';
import { aiApi } from './routes/ai.js';
import { addClient } from './realtime/sse.js';
import { startProviders } from './providers/registry.js';
import { syncContacts } from './contacts/carddav.js';
import { computeFrequentContacts } from './ai/tagging.js';
import { createTag, getTags } from './store/db.js';

async function main() {
  checkConfig();
  initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // API + SSE (SSE accepts ?token= since EventSource can't set headers)
  app.use('/api', api);
  app.use('/api', aiApi);
  app.get('/events', (req, res) => {
    if (!checkAuth(req as never)) return res.status(401).end();
    addClient(res);
  });

  // Serve the built React UI (web/dist). index.html must always revalidate
  // (it references hashed assets); hashed assets are immutable forever.
  if (existsSync(config.webDir)) {
    app.use(
      express.static(config.webDir, {
        setHeaders: (res, path) => {
          if (path.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: config.webDir });
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send(
        'universal-messenger backend is running. Build the UI with `npm run build:web` to serve the app here.'
      );
    });
  }

  app.listen(config.port, config.host, () => {
    console.log(`[server] listening on ${config.host}:${config.port}`);
  });

  // Background workers
  void syncContacts();
  setInterval(() => void syncContacts(), Math.max(60_000, config.nextcloud.syncIntervalMs));
  // Seed the AI taxonomy on first run (before stats tags create theirs).
  if (getTags().length === 0) {
    createTag('hospital', 'Day job / work at the hospital', '#d32f2f');
    createTag('glia', 'Glia — medical nonprofit project', '#008069');
    createTag('palestine', 'Palestinian cause, news, and related topics', '#2e7d32');
    createTag('personal', 'Family and personal life', '#1976d2');
  }
  // Stats-driven tags (frequent contact) — at boot and daily.
  void computeFrequentContacts();
  setInterval(() => void computeFrequentContacts(), 24 * 3600_000);
  await startProviders();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
