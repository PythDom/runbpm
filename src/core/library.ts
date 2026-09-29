/**
 * Bibliothèque musicale : chaque morceau doit avoir un tempo (BPM) et une durée.
 *
 * Import CSV (séparateur , ; ou tabulation) ou JSON. Les noms de colonnes sont reconnus
 * de façon souple, en français comme en anglais, y compris les exports de type Exportify
 * ("Track Name", "Artist Name(s)", "Duration (ms)", "Tempo").
 */

export interface Song {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  /** Durée en secondes. */
  duration: number;
  /** Chemin ou URL du fichier audio, repris dans l'export M3U. */
  file?: string;
}

export interface LibraryImport {
  songs: Song[];
  warnings: string[];
}

const COLUMN_ALIASES: Record<keyof Omit<Song, 'id'>, string[]> = {
  title: ['title', 'titre', 'track name', 'track', 'name', 'nom', 'song', 'chanson', 'morceau'],
  artist: ['artist', 'artiste', 'artist name(s)', 'artist name', 'artists', 'artistes', 'interprete', 'interprète'],
  bpm: ['bpm', 'tempo'],
  duration: ['duration', 'durée', 'duree', 'duration (ms)', 'duration_ms', 'length', 'longueur', 'time', 'temps'],
  file: ['file', 'fichier', 'path', 'chemin', 'url', 'location'],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/^﻿/, '');
}

function findColumn(headers: string[], field: keyof typeof COLUMN_ALIASES): number {
  const norm = headers.map(normalizeHeader);
  for (const alias of COLUMN_ALIASES[field]) {
    const idx = norm.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Découpe un CSV en tenant compte des guillemets (RFC 4180). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim =
    delimiter ??
    [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function parseNumber(s: string): number | undefined {
  const n = Number.parseFloat(s.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Durée : "3:45", "1:02:03", "225" (secondes) ou millisecondes (colonne "ms" ou valeur > 10000).
 */
export function parseDuration(value: string, headerHint = ''): number | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v.includes(':')) {
    const parts = v.split(':').map((p) => Number.parseFloat(p.replace(',', '.')));
    if (parts.some((p) => !Number.isFinite(p))) return undefined;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const n = parseNumber(v);
  if (n === undefined) return undefined;
  if (/ms/i.test(headerHint) || n > 10_000) return n / 1000;
  return n;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `s${Date.now().toString(36)}${idCounter}`;
}

function validate(partial: Partial<Song>, line: number, warnings: string[]): Song | undefined {
  const where = `ligne ${line}`;
  if (!partial.bpm || partial.bpm < 40 || partial.bpm > 260) {
    warnings.push(`${where} : BPM manquant ou invalide, morceau ignoré.`);
    return undefined;
  }
  if (!partial.duration || partial.duration < 20) {
    warnings.push(`${where} : durée manquante ou invalide, morceau ignoré.`);
    return undefined;
  }
  return {
    id: newId(),
    title: partial.title?.trim() || 'Sans titre',
    artist: partial.artist?.trim() || 'Artiste inconnu',
    bpm: Math.round(partial.bpm * 10) / 10,
    duration: Math.round(partial.duration),
    file: partial.file?.trim() || undefined,
  };
}

export function parseLibraryCsv(text: string): LibraryImport {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Le CSV doit contenir une ligne d’en-têtes et au moins un morceau.');
  const headers = rows[0];
  const cols = {
    title: findColumn(headers, 'title'),
    artist: findColumn(headers, 'artist'),
    bpm: findColumn(headers, 'bpm'),
    duration: findColumn(headers, 'duration'),
    file: findColumn(headers, 'file'),
  };
  if (cols.bpm < 0) throw new Error('Colonne BPM introuvable (attendu : "bpm" ou "tempo").');
  if (cols.duration < 0) throw new Error('Colonne durée introuvable (attendu : "duration", "durée", "duration (ms)"…).');
  const warnings: string[] = [];
  const songs: Song[] = [];
  rows.slice(1).forEach((r, k) => {
    const get = (i: number) => (i >= 0 ? (r[i] ?? '') : '');
    const song = validate(
      {
        title: get(cols.title),
        artist: get(cols.artist),
        bpm: parseNumber(get(cols.bpm)),
        duration: parseDuration(get(cols.duration), headers[cols.duration]),
        file: get(cols.file),
      },
      k + 2,
      warnings,
    );
    if (song) songs.push(song);
  });
  return { songs, warnings };
}

export function parseLibraryJson(text: string): LibraryImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Fichier JSON invalide.');
  }
  const list = Array.isArray(data) ? data : (data as { songs?: unknown })?.songs;
  if (!Array.isArray(list)) throw new Error('Le JSON doit être un tableau de morceaux ou { "songs": [...] }.');
  const warnings: string[] = [];
  const songs: Song[] = [];
  list.forEach((item, k) => {
    if (typeof item !== 'object' || item === null) return;
    const o = item as Record<string, unknown>;
    const str = (...keys: string[]) => {
      for (const key of keys) if (typeof o[key] === 'string') return o[key] as string;
      return undefined;
    };
    const val = (...keys: string[]) => {
      for (const key of keys) {
        const v = o[key];
        if (typeof v === 'number') return String(v);
        if (typeof v === 'string') return v;
      }
      return '';
    };
    const durationKey = ['duration_ms', 'durationMs'].find((key) => key in o);
    const song = validate(
      {
        title: str('title', 'titre', 'name'),
        artist: str('artist', 'artiste'),
        bpm: parseNumber(val('bpm', 'tempo')),
        duration: parseDuration(
          durationKey ? val(durationKey) : val('duration', 'duree', 'durée'),
          durationKey ?? '',
        ),
        file: str('file', 'path', 'url'),
      },
      k + 1,
      warnings,
    );
    if (song) songs.push(song);
  });
  return { songs, warnings };
}

export function parseLibraryFile(fileName: string, text: string): LibraryImport {
  if (fileName.toLowerCase().endsWith('.json') || text.trimStart().startsWith('[') || text.trimStart().startsWith('{')) {
    return parseLibraryJson(text);
  }
  return parseLibraryCsv(text);
}

/** Fusionne deux bibliothèques en évitant les doublons (même titre + artiste). */
export function mergeLibraries(a: Song[], b: Song[]): Song[] {
  const key = (s: Song) => `${s.title.toLowerCase()}|${s.artist.toLowerCase()}`;
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((s) => !seen.has(key(s)))];
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
