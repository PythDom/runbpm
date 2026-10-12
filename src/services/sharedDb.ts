import type { Song } from '../core/library';

/**
 * Client de la base partagée (server/runbpm_server.py, hébergé par exemple sur PythonAnywhere) :
 * BPM des morceaux Navidrome mesurés une fois pour tous les utilisateurs, et sélection « course »
 * de chacun. Chaque utilisateur s'identifie avec son code d'accès « nom:secret ».
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

/** Adresse du serveur normalisée : schéma ajouté (https par défaut), sans « / » ni « /api » final. */
export function normalizeServerUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `${/^(localhost|127\.|192\.168\.|10\.)/.test(u) ? 'http' : 'https'}://${u}`;
  return u;
}

export class SharedDb {
  private readonly base: string;

  constructor(
    serverUrl: string,
    /** Code d'accès « nom:secret » remis par l'administrateur de la base. */
    private readonly code: string,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
  ) {
    this.base = `${normalizeServerUrl(serverUrl)}/api/`;
  }

  /** Nom d'utilisateur contenu dans le code d'accès. */
  get user(): string {
    return this.code.split(':')[0];
  }

  /** État du serveur ; undefined s'il ne répond pas comme une base RunBPM. */
  static async health(serverUrl: string, fetchImpl: Fetch = (...args) => fetch(...args)): Promise<SharedHealth | undefined> {
    try {
      const res = await fetchImpl(`${normalizeServerUrl(serverUrl)}/api/health`, { cache: 'no-store' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
      const body = (await res.json()) as SharedHealth;
      return body?.ok ? body : undefined;
    } catch {
      return undefined;
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: { 'X-RunBPM-Key': this.code, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SharedDbError('Base partagée injoignable (réseau ou adresse).', 0);
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new SharedDbError(data.error ?? `Base partagée : erreur ${res.status}.`, res.status);
    return data;
  }

  /** Vérifie le code d'accès ; renvoie le nom d'utilisateur. */
  async whoami(): Promise<string> {
    return (await this.call<{ user: string }>('GET', 'whoami')).user;
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
