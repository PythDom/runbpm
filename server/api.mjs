// API de la base partagée RunBPM (sans dépendance) : morceaux du serveur Navidrome avec leur BPM,
// et sélection « course » de chaque utilisateur.
//
// Identité : chaque requête porte les identifiants Subsonic de l'utilisateur (u, t, s) ; ils sont
// vérifiés auprès du serveur Navidrome configuré (NAVIDROME_URL). Pas de comptes à gérer :
// quiconque a un compte Navidrome peut lire la liste, la compléter et tenir sa propre sélection.
//
// Stockage : un fichier JSON écrit de façon atomique (fichier temporaire puis renommage).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_BODY = 8 * 1024 * 1024;
const AUTH_TTL_MS = 10 * 60 * 1000;
const BPM_SOURCES = new Set(['tag', 'analyse', 'import', 'manuel']);

/** @typedef {{ id: string, title: string, artist: string, album?: string, duration: number, bpm: number, bpmSource: string, confidence?: number, updatedAt: string, updatedBy?: string }} SharedSong */

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Requête trop volumineuse.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON invalide.'), { status: 400 });
  }
}

/** Nettoie un morceau reçu ; renvoie undefined s'il est inexploitable. */
function cleanSong(s) {
  if (!s || typeof s !== 'object') return undefined;
  const id = typeof s.id === 'string' ? s.id.slice(0, 200) : '';
  const bpm = Number(s.bpm);
  const duration = Number(s.duration);
  if (!id || !(bpm >= 40 && bpm <= 260) || !(duration > 0)) return undefined;
  const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const confidence = Number(s.confidence);
  return {
    id,
    title: text(s.title) ?? 'Sans titre',
    artist: text(s.artist) ?? 'Artiste inconnu',
    album: text(s.album),
    duration: Math.round(duration),
    bpm: Math.round(bpm * 10) / 10,
    bpmSource: BPM_SOURCES.has(s.bpmSource) ? s.bpmSource : 'analyse',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
  };
}

/**
 * @param {{ dataFile: string, navidromeUrl?: string, fetchImpl?: typeof fetch, saveDelayMs?: number }} options
 * @returns {{ handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: () => void) => Promise<void>, flush: () => Promise<void>, db: () => Promise<any> }}
 */
export function createApi(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const navidromeUrl = options.navidromeUrl?.replace(/\/+$/, '');
  const authCache = new Map();
  let db;
  let saveTimer;
  let saving = Promise.resolve();

  async function load() {
    if (db) return db;
    try {
      db = JSON.parse(await readFile(options.dataFile, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      db = { version: 1, songs: {}, selections: {} };
    }
    db.songs ??= {};
    db.selections ??= {};
    return db;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(), options.saveDelayMs ?? 300);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!db) return;
    const snapshot = JSON.stringify(db);
    saving = saving.then(async () => {
      await mkdir(dirname(options.dataFile), { recursive: true });
      const tmp = `${options.dataFile}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, options.dataFile);
    });
    return saving;
  }

  /** Vérifie les identifiants Subsonic auprès de Navidrome ; renvoie le nom d'utilisateur. */
  async function authenticate(req) {
    if (!navidromeUrl) throw Object.assign(new Error('Base partagée non configurée : définissez NAVIDROME_URL.'), { status: 503 });
    const params = new URLSearchParams(String(req.headers['x-runbpm-auth'] ?? ''));
    const u = params.get('u');
    const t = params.get('t');
    const s = params.get('s');
    if (!u || !t || !s) throw Object.assign(new Error('Connectez-vous à Navidrome.'), { status: 401 });
    const key = `${u}\n${t}\n${s}`;
    const cached = authCache.get(key);
    if (cached && cached > Date.now()) return u;
    const q = new URLSearchParams({ u, t, s, v: '1.16.1', c: 'RunBPM-server', f: 'json' });
    let ok = false;
    try {
      const r = await fetchImpl(`${navidromeUrl}/rest/ping?${q}`);
      const body = await r.json();
      ok = body?.['subsonic-response']?.status === 'ok';
    } catch {
      throw Object.assign(new Error(`Navidrome injoignable depuis le serveur RunBPM (${navidromeUrl}).`), { status: 502 });
    }
    if (!ok) throw Object.assign(new Error('Identifiants Navidrome refusés.'), { status: 401 });
    authCache.set(key, Date.now() + AUTH_TTL_MS);
    return u;
  }

  async function handle(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (next) return next();
      return send(res, 404, { error: 'Introuvable.' });
    }
    try {
      const path = url.pathname;
      if (path === '/api/health' && req.method === 'GET') {
        const d = await load();
        return send(res, 200, { ok: true, configured: !!navidromeUrl, navidrome: navidromeUrl ?? null, songs: Object.keys(d.songs).length });
      }
      const user = await authenticate(req);
      const d = await load();

      if (path === '/api/songs' && req.method === 'GET') {
        return send(res, 200, { songs: Object.values(d.songs) });
      }
      if (path === '/api/songs' && req.method === 'POST') {
        const body = await readJson(req);
        let added = 0;
        let updated = 0;
        let kept = 0;
        let unchanged = 0;
        for (const raw of Array.isArray(body.songs) ? body.songs : []) {
          const s = cleanSong(raw);
          if (!s) continue;
          const existing = d.songs[s.id];
          if (existing?.bpmSource === 'manuel' && s.bpmSource !== 'manuel') {
            // Une correction manuelle prime sur une nouvelle analyse : on ne met à jour que les métadonnées.
            d.songs[s.id] = { ...existing, title: s.title, artist: s.artist, album: s.album, duration: s.duration };
            kept++;
            continue;
          }
          if (existing && existing.bpm === s.bpm && existing.bpmSource === s.bpmSource) {
            d.songs[s.id] = { ...existing, title: s.title, artist: s.artist, album: s.album, duration: s.duration };
            unchanged++;
            continue;
          }
          d.songs[s.id] = { ...s, updatedAt: new Date().toISOString(), updatedBy: user };
          if (existing) updated++;
          else added++;
        }
        scheduleSave();
        return send(res, 200, { added, updated, kept, unchanged, total: Object.keys(d.songs).length });
      }
      const m = /^\/api\/songs\/(.+)$/.exec(path);
      if (m && req.method === 'PATCH') {
        const id = decodeURIComponent(m[1]);
        const existing = d.songs[id];
        if (!existing) return send(res, 404, { error: 'Morceau inconnu de la base partagée.' });
        const body = await readJson(req);
        const bpm = Number(body.bpm);
        if (!(bpm >= 40 && bpm <= 260)) return send(res, 400, { error: 'BPM invalide (40 à 260).' });
        d.songs[id] = { ...existing, bpm: Math.round(bpm * 10) / 10, bpmSource: 'manuel', confidence: undefined, updatedAt: new Date().toISOString(), updatedBy: user };
        scheduleSave();
        return send(res, 200, { song: d.songs[id] });
      }
      if (path === '/api/selection' && req.method === 'GET') {
        return send(res, 200, { user, selected: d.selections[user] ?? [] });
      }
      if (path === '/api/selection' && req.method === 'PUT') {
        const body = await readJson(req);
        const ids = Array.isArray(body.selected) ? [...new Set(body.selected.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)))] : [];
        d.selections[user] = ids.slice(0, 200000);
        scheduleSave();
        return send(res, 200, { user, selected: d.selections[user] });
      }
      return send(res, 404, { error: 'Introuvable.' });
    } catch (e) {
      return send(res, e.status ?? 500, { error: e.status ? e.message : 'Erreur interne du serveur RunBPM.' });
    }
  }

  return { handle, flush, db: load };
}
