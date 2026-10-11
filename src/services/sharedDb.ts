import type { Song } from '../core/library';
import type { SubsonicCredentials } from './subsonic';

/**
 * Client de la base partagée servie par RunBPM (server/api.mjs) : BPM des morceaux Navidrome
 * mesurés une fois pour tous les utilisateurs, et sélection « course » de chacun.
 * L'identité est celle de Navidrome : on transmet le jeton Subsonic, jamais le mot de passe.
 */

export interface SharedSong {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  bpm: number;
  bpmSource: NonNullable<Song['bpmSource']>;
  confidence?: number;
  updatedAt?: string;
  updatedBy?: string;
}

export interface SharedHealth {
  ok: boolean;
  configured: boolean;
  navidrome: string | null;
  songs: number;
}

type Fetch = typeof fetch;

export class SharedDbError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Morceau de la bibliothèque → fiche partagée (morceaux du serveur uniquement). */
export function toShared(s: Song): SharedSong | undefined {
  if (!s.navidromeId) return undefined;
  return {
    id: s.navidromeId,
    title: s.title,
    artist: s.artist,
    duration: s.duration,
    bpm: s.bpm,
    bpmSource: s.bpmSource ?? 'analyse',
    confidence: s.confidence,
  };
}

/** Fiche partagée → morceau de la bibliothèque. */
export function fromShared(s: SharedSong): Song {
  return {
    id: `nd-${s.id}`,
    title: s.title,
    artist: s.artist,
    duration: s.duration,
    bpm: s.bpm,
    bpmSource: s.bpmSource,
    confidence: s.confidence ?? undefined,
    navidromeId: s.id,
  };
}

export class SharedDb {
  constructor(
    private readonly creds: SubsonicCredentials,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
    private readonly base = 'api/',
  ) {}

  /** État du serveur RunBPM ; undefined si l'API n'est pas servie (site statique, artefact…). */
  static async health(fetchImpl: Fetch = (...args) => fetch(...args), base = 'api/'): Promise<SharedHealth | undefined> {
    try {
      const res = await fetchImpl(`${base}health`, { cache: 'no-store' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
      const body = (await res.json()) as SharedHealth;
      return body?.ok ? body : undefined;
    } catch {
      return undefined;
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = new URLSearchParams({ u: this.creds.user, t: this.creds.token, s: this.creds.salt }).toString();
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: { 'X-RunBPM-Auth': auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SharedDbError('Serveur RunBPM injoignable.', 0);
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new SharedDbError(data.error ?? `Base partagée : erreur ${res.status}.`, res.status);
    return data;
  }

  async songs(): Promise<SharedSong[]> {
    return (await this.call<{ songs: SharedSong[] }>('GET', 'songs')).songs;
  }

  /** Envoie des morceaux par lots ; renvoie le total de la base. */
  async upsert(songs: SharedSong[], batch = 500): Promise<{ added: number; updated: number; total: number }> {
    const sum = { added: 0, updated: 0, total: 0 };
    for (let i = 0; i < songs.length; i += batch) {
      const r = await this.call<{ added: number; updated: number; total: number }>('POST', 'songs', { songs: songs.slice(i, i + batch) });
      sum.added += r.added;
      sum.updated += r.updated;
      sum.total = r.total;
    }
    return sum;
  }

  async setBpm(id: string, bpm: number): Promise<SharedSong> {
    return (await this.call<{ song: SharedSong }>('PATCH', `songs/${encodeURIComponent(id)}`, { bpm })).song;
  }

  async selection(): Promise<string[]> {
    return (await this.call<{ selected: string[] }>('GET', 'selection')).selected;
  }

  async saveSelection(ids: string[]): Promise<void> {
    await this.call('PUT', 'selection', { selected: ids });
  }
}

/**
 * Fusionne les fiches partagées dans la bibliothèque locale. Pour un morceau déjà présent, la base
 * partagée fait foi, sauf correction manuelle locale face à une simple analyse (elle sera envoyée).
 * Renvoie la bibliothèque et les morceaux locaux à envoyer (absents du serveur ou corrigés ici).
 */
export function mergeShared(library: Song[], shared: SharedSong[]): { library: Song[]; toUpload: SharedSong[]; received: number } {
  const byNd = new Map(shared.map((s) => [s.id, s]));
  const known = new Set<string>();
  const toUpload: SharedSong[] = [];
  let received = 0;
  const reconcile = (song: Song, remote: SharedSong): Song => {
    if (song.bpmSource === 'manuel' && remote.bpmSource !== 'manuel') {
      if (song.bpm !== remote.bpm) toUpload.push(toShared(song)!);
      return song;
    }
    if (song.bpm === remote.bpm && song.bpmSource === remote.bpmSource) return song;
    received++;
    return { ...song, bpm: remote.bpm, bpmSource: remote.bpmSource, confidence: remote.confidence ?? undefined };
  };
  const out = library.map((song) => {
    if (!song.navidromeId) return song;
    known.add(song.navidromeId);
    const remote = byNd.get(song.navidromeId);
    if (remote) return reconcile(song, remote);
    toUpload.push(toShared(song)!);
    return song;
  });
  // Titre + artiste déjà présents sans lien serveur (ex. analysé depuis les fichiers locaux) : on relie.
  const norm = (s: { title: string; artist: string }) => `${s.title.toLowerCase()}|${s.artist.toLowerCase()}`;
  const byKey = new Map(out.map((s, i) => [norm(s), i] as const).filter(([, i]) => !out[i].navidromeId));
  for (const remote of shared) {
    if (known.has(remote.id)) continue;
    const i = byKey.get(norm(remote));
    if (i !== undefined) {
      out[i] = reconcile({ ...out[i], navidromeId: remote.id }, remote);
      byKey.delete(norm(remote));
      continue;
    }
    out.push(fromShared(remote));
    received++;
  }
  return { library: out, toUpload, received };
}
