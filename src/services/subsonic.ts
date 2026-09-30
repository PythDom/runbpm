import { md5 } from '../core/md5';

/**
 * Client de l'API Subsonic / OpenSubsonic (Navidrome, Gonic, Airsonic…), entièrement côté
 * navigateur. Navidrome autorise les appels depuis n'importe quelle origine (CORS « * »).
 *
 * Authentification par jeton : t = md5(motDePasse + sel). Seuls l'utilisateur, le jeton et le sel
 * sont conservés, jamais le mot de passe.
 */

export const CLIENT_NAME = 'RunBPM';
const API_VERSION = '1.16.1';

export interface SubsonicCredentials {
  /** Adresse du serveur, ex. http://192.168.1.10:4533 */
  url: string;
  user: string;
  token: string;
  salt: string;
}

export interface SubsonicSong {
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** Durée en secondes. */
  duration: number;
  /** BPM des tags (0 ou absent si inconnu). */
  bpm?: number;
  size?: number;
  suffix?: string;
  contentType?: string;
  path?: string;
}

export class SubsonicError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'SubsonicError';
  }
}

type Fetch = typeof fetch;

/** Normalise l'adresse saisie (schéma par défaut, sans barre finale ni /app/ de l'interface web). */
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+(app\/?(#.*)?)?$/i, '').replace(/\/+$/, '');
}

export function makeCredentials(url: string, user: string, password: string, salt = randomSalt()): SubsonicCredentials {
  return { url: normalizeServerUrl(url), user: user.trim(), salt, token: md5(password + salt) };
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Messages Subsonic courants traduits. */
function explain(code: number | undefined, message: string): string {
  if (code === 40) return 'Identifiant ou mot de passe incorrect.';
  if (code === 41) return 'Ce serveur n’accepte pas l’authentification par jeton.';
  if (code === 50) return 'Accès refusé pour cet utilisateur.';
  if (code === 70) return 'Élément introuvable sur le serveur.';
  return message || `Erreur Subsonic ${code ?? ''}`.trim();
}

export class SubsonicClient {
  constructor(
    readonly creds: SubsonicCredentials,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
  ) {}

  /** URL d'un point d'accès avec les paramètres d'authentification. */
  url(endpoint: string, params: Record<string, string | number | (string | number)[]> = {}): string {
    const q = new URLSearchParams({ u: this.creds.user, t: this.creds.token, s: this.creds.salt, v: API_VERSION, c: CLIENT_NAME, f: 'json' });
    for (const [k, v] of Object.entries(params)) {
      for (const item of Array.isArray(v) ? v : [v]) q.append(k, String(item));
    }
    return `${this.creds.url}/rest/${endpoint}?${q}`;
  }

  async call<T = Record<string, unknown>>(endpoint: string, params: Record<string, string | number | (string | number)[]> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(endpoint, params));
    } catch {
      throw new SubsonicError(
        `Serveur injoignable (${this.creds.url}). Vérifiez l’adresse ; si RunBPM est ouvert en HTTPS, le serveur doit l’être aussi.`,
      );
    }
    if (!res.ok) throw new SubsonicError(`Le serveur a répondu ${res.status} ${res.statusText}.`);
    const body = (await res.json().catch(() => undefined)) as { 'subsonic-response'?: Record<string, unknown> } | undefined;
    const r = body?.['subsonic-response'];
    if (!r) throw new SubsonicError('Réponse inattendue : est-ce bien un serveur Subsonic / Navidrome ?');
    if (r.status !== 'ok') {
      const err = r.error as { code?: number; message?: string } | undefined;
      throw new SubsonicError(explain(err?.code, err?.message ?? ''), err?.code);
    }
    return r as T;
  }

  async ping(): Promise<{ serverName: string; version?: string }> {
    const r = await this.call<{ type?: string; serverVersion?: string; version?: string }>('ping');
    return { serverName: r.type ?? 'Subsonic', version: r.serverVersion ?? r.version };
  }

  /** Toute la bibliothèque, par pages (recherche vide, prise en charge par Navidrome et OpenSubsonic). */
  async *allSongs(pageSize = 500): AsyncGenerator<SubsonicSong[]> {
    for (let offset = 0; ; offset += pageSize) {
      const r = await this.call<{ searchResult3?: { song?: RawSong[] } }>('search3', {
        query: '',
        songCount: pageSize,
        songOffset: offset,
        artistCount: 0,
        albumCount: 0,
      });
      const songs = (r.searchResult3?.song ?? []).map(toSong);
      if (songs.length > 0) yield songs;
      if (songs.length < pageSize) return;
    }
  }

  /** URL de lecture. `raw` : fichier d'origine ; sinon transcodage demandé au serveur. */
  streamUrl(id: string, opts: { format?: string; maxBitRate?: number } = {}): string {
    const params: Record<string, string | number> = { id, format: opts.format ?? 'raw' };
    if (opts.maxBitRate) params.maxBitRate = opts.maxBitRate;
    return this.url('stream', params);
  }

  /** Lit une plage d'octets du fichier d'origine (requête HTTP Range). */
  async readRange(id: string, offset: number, length: number): Promise<Uint8Array> {
    const res = await this.fetchImpl(this.streamUrl(id), { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!res.ok) throw new SubsonicError(`Lecture du fichier impossible (${res.status}).`);
    const data = new Uint8Array(await res.arrayBuffer());
    // Serveur sans prise en charge des plages : il renvoie tout le fichier.
    return res.status === 206 ? data : data.subarray(offset, offset + length);
  }

  /** Crée une playlist (par lots de 100 morceaux pour limiter la longueur des URL). */
  async createPlaylist(name: string, songIds: string[]): Promise<string> {
    const r = await this.call<{ playlist?: { id: string } }>('createPlaylist', { name, songId: songIds.slice(0, 100) });
    let id = r.playlist?.id;
    if (!id) {
      // Anciens serveurs : la réponse ne contient pas la playlist, on la retrouve par son nom.
      const list = await this.call<{ playlists?: { playlist?: { id: string; name: string }[] } }>('getPlaylists');
      id = list.playlists?.playlist?.filter((p) => p.name === name).pop()?.id;
      if (!id) throw new SubsonicError('Playlist créée mais introuvable.');
    }
    for (let i = 100; i < songIds.length; i += 100) {
      await this.call('updatePlaylist', { playlistId: id, songIdToAdd: songIds.slice(i, i + 100) });
    }
    return id;
  }
}

interface RawSong {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  bpm?: number;
  size?: number;
  suffix?: string;
  contentType?: string;
  path?: string;
  isDir?: boolean;
  isVideo?: boolean;
}

function toSong(s: RawSong): SubsonicSong {
  return {
    id: String(s.id),
    title: s.title ?? 'Sans titre',
    artist: s.artist ?? 'Artiste inconnu',
    album: s.album,
    duration: s.duration ?? 0,
    bpm: s.bpm && s.bpm > 0 ? s.bpm : undefined,
    size: s.size,
    suffix: s.suffix,
    contentType: s.contentType,
    path: s.path,
  };
}
