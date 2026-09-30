import type { Song } from '../core/library';
import { normalizeName } from '../core/names';
import type { SubsonicClient, SubsonicSong } from '../services/subsonic';
import { measureTempo, type AudioSource } from './analyzer';

/** Taille de l'extrait transcodé lu pour mesurer le tempo des formats autres que MP3. */
const PREFIX_BYTES = 2.5 * 1024 * 1024;

/** Lit au plus `maxBytes` d'un flux HTTP puis interrompt le téléchargement. */
async function readPrefix(url: string, maxBytes: number): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`flux indisponible (${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  void reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(total, maxBytes));
  let o = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - o);
    out.set(part, o);
    o += part.length;
    if (o >= out.length) break;
  }
  return out.buffer;
}

/** Morceau distant vu comme une source audio : lectures par plages, extrait transcodé si besoin. */
export function remoteSource(client: SubsonicClient, s: SubsonicSong): AudioSource {
  const suffix = (s.suffix ?? s.path?.split('.').pop() ?? '').toLowerCase();
  return {
    name: `${s.artist} - ${s.title}.${suffix || 'audio'}`,
    size: s.size ?? 0,
    read: (offset, length) => client.readRange(s.id, offset, length),
    // MP3 : fichier d'origine ; autres formats (FLAC…) : début du morceau transcodé en MP3 par le serveur.
    readForDecoding: () =>
      suffix === 'mp3'
        ? fetch(client.streamUrl(s.id)).then((r) => r.arrayBuffer())
        : readPrefix(client.streamUrl(s.id, { format: 'mp3', maxBitRate: 128 }), PREFIX_BYTES),
    // Serveur sans transcodage : fichier d'origine complet.
    fallbackForDecoding: () => fetch(client.streamUrl(s.id)).then((r) => r.arrayBuffer()),
  };
}

export interface NavidromeImportProgress {
  phase: 'liste' | 'analyse';
  done: number;
  total: number;
  current?: string;
  added: number;
  linked: number;
  failed: number;
}

const keyOf = (title: string, artist: string) => `${normalizeName(title)}|${normalizeName(artist)}`;

/**
 * Importe la bibliothèque du serveur. Un morceau déjà présent (même titre et artiste, par exemple
 * analysé depuis les fichiers locaux) est simplement relié au serveur, sans nouvelle analyse :
 * ses éventuelles corrections de BPM sont conservées.
 */
export async function importNavidrome(
  client: SubsonicClient,
  library: Song[],
  opts: { useTagBpm: boolean },
  onSong: (song: Song) => void,
  onProgress: (p: NavidromeImportProgress) => void,
  signal: { cancelled: boolean },
): Promise<{ progress: NavidromeImportProgress; errors: string[] }> {
  const progress: NavidromeImportProgress = { phase: 'liste', done: 0, total: 0, added: 0, linked: 0, failed: 0 };
  const errors: string[] = [];
  const remote: SubsonicSong[] = [];
  for await (const page of client.allSongs()) {
    remote.push(...page);
    progress.done = remote.length;
    onProgress(progress);
    if (signal.cancelled) return { progress, errors };
  }

  const byNavidromeId = new Set(library.map((s) => s.navidromeId).filter(Boolean));
  const byKey = new Map(library.map((s) => [keyOf(s.title, s.artist), s]));
  const todo: SubsonicSong[] = [];
  for (const s of remote) {
    if (byNavidromeId.has(s.id)) continue;
    const existing = byKey.get(keyOf(s.title, s.artist));
    if (existing) {
      existing.navidromeId ??= s.id;
      progress.linked++;
    } else if (s.duration >= 20) {
      todo.push(s);
    }
  }

  progress.phase = 'analyse';
  progress.done = 0;
  progress.total = todo.length;
  onProgress(progress);
  for (const s of todo) {
    if (signal.cancelled) break;
    progress.current = `${s.artist} - ${s.title}`;
    onProgress(progress);
    const base = { id: `nd-${s.id}`, title: s.title, artist: s.artist, duration: Math.round(s.duration), navidromeId: s.id, file: s.path };
    try {
      if (opts.useTagBpm && s.bpm) {
        onSong({ ...base, bpm: s.bpm, bpmSource: 'tag' });
      } else {
        const tempo = await measureTempo(remoteSource(client, s));
        onSong({ ...base, bpm: tempo.bpm, bpmSource: 'analyse', confidence: tempo.confidence });
      }
      progress.added++;
    } catch (e) {
      progress.failed++;
      errors.push(`${s.artist} - ${s.title} : ${(e as Error).message}`);
    }
    progress.done++;
    onProgress(progress);
    await new Promise((r) => setTimeout(r, 0));
  }
  progress.current = undefined;
  return { progress, errors };
}
