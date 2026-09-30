/**
 * Intégration Spotify, entièrement côté navigateur.
 *
 * - Connexion OAuth « Authorization Code + PKCE » : aucun secret n'est nécessaire, chaque
 *   utilisateur renseigne le Client ID de sa propre application Spotify (mode développement).
 * - Web API : recherche des morceaux, création de la playlist, lecture de l'état du lecteur
 *   (pour caler le métronome sur le morceau réellement joué par l'application Spotify).
 *
 * Contraintes Spotify (2026) : compte Premium obligatoire en mode développement, 5 utilisateurs
 * autorisés par application, pas de tempo (audio-features supprimé). L'adresse de redirection
 * doit être en HTTPS ou en 127.0.0.1 (« localhost » est refusé).
 */

export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'playlist-modify-private',
  'playlist-modify-public',
];

type Fetch = typeof fetch;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Stockage sans erreur : navigation privée ou stockage bloqué ne doivent rien casser. */
export function safeStorage(get: () => Storage): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    getItem: (k) => {
      try {
        return get().getItem(k);
      } catch {
        return memory.get(k) ?? null;
      }
    },
    setItem: (k, v) => {
      try {
        get().setItem(k, v);
      } catch {
        memory.set(k, v);
      }
    },
    removeItem: (k) => {
      try {
        get().removeItem(k);
      } catch {
        memory.delete(k);
      }
    },
  };
}

// ---------- PKCE ----------

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(length = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// ---------- Authentification ----------

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Horodatage (ms) d'expiration du jeton d'accès. */
  expiresAt: number;
}

export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyError';
  }
}

const KEY_CLIENT = 'runbpm.spotify.clientId';
const KEY_TOKENS = 'runbpm.spotify.tokens';
const KEY_VERIFIER = 'runbpm.spotify.verifier';
const KEY_STATE = 'runbpm.spotify.state';

export class SpotifyAuth {
  private refreshing?: Promise<string>;

  constructor(
    private readonly store: KeyValueStore,
    private readonly session: KeyValueStore,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
  ) {}

  get clientId(): string {
    return this.store.getItem(KEY_CLIENT) ?? '';
  }

  set clientId(id: string) {
    const v = id.trim();
    if (v !== this.clientId) this.logout();
    if (v) this.store.setItem(KEY_CLIENT, v);
    else this.store.removeItem(KEY_CLIENT);
  }

  get loggedIn(): boolean {
    return this.tokens() !== undefined;
  }

  /** Adresse de redirection : la page elle-même (à déclarer dans l'application Spotify). */
  static redirectUri(loc: { origin: string; pathname: string }): string {
    return loc.origin + loc.pathname;
  }

  /** URL d'autorisation ; mémorise le vérificateur PKCE pour le retour. */
  async authorizeUrl(redirectUri: string): Promise<string> {
    if (!/^[0-9a-f]{32}$/i.test(this.clientId)) {
      throw new Error('Client ID Spotify invalide (32 caractères hexadécimaux).');
    }
    const verifier = randomString(64);
    const state = randomString(16);
    this.session.setItem(KEY_VERIFIER, verifier);
    this.session.setItem(KEY_STATE, state);
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: await codeChallenge(verifier),
      scope: SPOTIFY_SCOPES.join(' '),
      state,
    });
    return `${SPOTIFY_ACCOUNTS}/authorize?${params}`;
  }

  /**
   * Traite le retour de Spotify (?code=…&state=…). Renvoie true si une connexion vient
   * d'aboutir, false s'il n'y avait rien à traiter ; lève une erreur en cas d'échec.
   */
  async handleRedirect(search: string, redirectUri: string): Promise<boolean> {
    const params = new URLSearchParams(search);
    const error = params.get('error');
    const code = params.get('code');
    if (!error && !code) return false;
    const expectedState = this.session.getItem(KEY_STATE);
    const verifier = this.session.getItem(KEY_VERIFIER);
    this.session.removeItem(KEY_STATE);
    this.session.removeItem(KEY_VERIFIER);
    if (error) throw new Error(error === 'access_denied' ? 'Connexion à Spotify refusée.' : `Spotify : ${error}`);
    if (!verifier || params.get('state') !== expectedState) {
      throw new Error('Retour de connexion Spotify inattendu (état invalide). Réessayez.');
    }
    await this.tokenRequest({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      code_verifier: verifier,
    });
    return true;
  }

  /** Jeton d'accès valide, rafraîchi si nécessaire. */
  async accessToken(forceRefresh = false): Promise<string> {
    const t = this.tokens();
    if (!t) throw new SpotifyError(401, 'Non connecté à Spotify.');
    if (!forceRefresh && t.expiresAt - Date.now() > 60_000) return t.accessToken;
    if (!t.refreshToken) {
      this.logout();
      throw new SpotifyError(401, 'Session Spotify expirée : reconnectez-vous.');
    }
    this.refreshing ??= this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: this.clientId,
    }).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  logout(): void {
    this.store.removeItem(KEY_TOKENS);
  }

  private tokens(): Tokens | undefined {
    try {
      const raw = this.store.getItem(KEY_TOKENS);
      return raw ? (JSON.parse(raw) as Tokens) : undefined;
    } catch {
      return undefined;
    }
  }

  private async tokenRequest(body: Record<string, string>): Promise<string> {
    const res = await this.fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (body.grant_type === 'refresh_token') this.logout();
      const desc = typeof data.error_description === 'string' ? data.error_description : res.statusText;
      throw new SpotifyError(res.status, `Authentification Spotify impossible : ${desc}`);
    }
    const previous = this.tokens();
    const tokens: Tokens = {
      accessToken: String(data.access_token),
      // Spotify ne renvoie pas toujours un nouveau refresh token : on garde l'ancien.
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previous?.refreshToken,
      expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    };
    this.store.setItem(KEY_TOKENS, JSON.stringify(tokens));
    return tokens.accessToken;
  }
}

// ---------- Web API ----------

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string[];
  durationMs: number;
}

export interface PlaybackState {
  uri?: string;
  positionMs: number;
  durationMs: number;
  paused: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function explain(status: number, apiMessage: string): string {
  if (status === 403) {
    return `Accès refusé par Spotify (${apiMessage}). Le mode développement exige un compte Premium, déclaré dans l’application développeur (User Management).`;
  }
  return `Spotify : ${apiMessage || `erreur ${status}`}`;
}

export class SpotifyApi {
  constructor(
    private readonly auth: SpotifyAuth,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.auth.accessToken(false);
      const res = await this.fetchImpl(`${SPOTIFY_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.auth.accessToken(true);
        continue;
      }
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After') ?? '1');
        await this.wait(Math.min(30, Math.max(1, retry)) * 1000);
        continue;
      }
      if (res.status === 204 || res.status === 202) return undefined as T;
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const msg = (data as { error?: { message?: string } })?.error?.message ?? res.statusText;
        throw new SpotifyError(res.status, explain(res.status, msg));
      }
      return data as T;
    }
    throw new SpotifyError(429, 'Spotify limite temporairement les requêtes : réessayez dans un instant.');
  }

  async me(): Promise<{ id: string; name: string }> {
    const u = await this.request<{ id: string; display_name?: string }>('GET', '/me');
    return { id: u.id, name: u.display_name || u.id };
  }

  async searchTracks(query: string, limit = 10): Promise<SpotifyTrack[]> {
    const params = new URLSearchParams({ q: query, type: 'track', limit: String(Math.min(10, limit)) });
    const res = await this.request<{ tracks?: { items?: RawTrack[] } }>('GET', `/search?${params}`);
    return (res.tracks?.items ?? []).filter(Boolean).map(toTrack);
  }

  /** Crée une playlist privée et y ajoute les morceaux dans l'ordre (par lots de 100). */
  async createPlaylist(name: string, description: string, uris: string[]): Promise<{ id: string; url: string }> {
    const pl = await this.request<{ id: string; external_urls?: { spotify?: string } }>('POST', '/me/playlists', {
      name,
      description,
      public: false,
    });
    for (let i = 0; i < uris.length; i += 100) {
      await this.request('POST', `/playlists/${pl.id}/items`, { uris: uris.slice(i, i + 100) });
    }
    return { id: pl.id, url: pl.external_urls?.spotify ?? `https://open.spotify.com/playlist/${pl.id}` };
  }

  async playbackState(): Promise<PlaybackState | undefined> {
    const s = await this.request<{ is_playing: boolean; progress_ms: number | null; item?: RawTrack | null } | undefined>(
      'GET',
      '/me/player',
    );
    if (!s) return undefined;
    return {
      uri: s.item?.uri,
      positionMs: s.progress_ms ?? 0,
      durationMs: s.item?.duration_ms ?? 0,
      paused: !s.is_playing,
    };
  }
}

interface RawTrack {
  uri: string;
  name: string;
  duration_ms: number;
  artists?: { name: string }[];
}

const toTrack = (t: RawTrack): SpotifyTrack => ({
  uri: t.uri,
  name: t.name,
  artists: (t.artists ?? []).map((a) => a.name),
  durationMs: t.duration_ms,
});
