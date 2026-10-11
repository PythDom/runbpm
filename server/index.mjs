// Serveur RunBPM autonome : sert l'application compilée (dist/) et l'API de la base partagée.
// Lancement : npm run build, puis npm start (voir README, « Base partagée »).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createApi } from './api.mjs';
import { loadConfig } from './config.mjs';

const config = loadConfig();
const api = createApi({ dataFile: config.dataFile, navidromeUrl: config.navidromeUrl });
const DIST = resolve('dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.gpx': 'application/gpx+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) rel = '';
  let file = join(DIST, rel || 'index.html');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html');
  }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Application non compilée : lancez « npm run build ».');
  }
}

const server = createServer((req, res) => {
  void api.handle(req, res, () => void serveStatic(req, res));
});
server.listen(config.port, config.host, () => {
  console.log(`RunBPM : http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(config.navidromeUrl ? `Base partagée : ${config.dataFile} (comptes de ${config.navidromeUrl})` : 'Base partagée désactivée : définissez NAVIDROME_URL.');
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void api.flush().finally(() => process.exit(0));
  });
}
