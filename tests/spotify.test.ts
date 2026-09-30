import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeSpotifyUri, parseLibraryCsv, type Song } from '../src/core/library';
import { planRun } from '../src/core/pacing';
import { generatePlaylist } from '../src/core/playlist';
import { cleanTitle, pickBestTrack, searchQuery } from '../src/core/spotifyMatch';
import { codeChallenge, SpotifyApi, SpotifyAuth, SpotifyError, type KeyValueStore } from '../src/services/spotify';

const ID = '4uLU6hMCjMI75M1A2tKUQC';
const song = (title: string, artist: string, duration = 200, extra: Partial<Song> = {}): Song => ({
  id: title,
  title,
  artist,
  bpm: 170,
  duration,
  ...extra,
});

describe('identifiants Spotify', () => {
  it('reconnaît URI, liens et ID seuls', () => {
    expect(normalizeSpotifyUri(`spotify:track:${ID}`)).toBe(`spotify:track:${ID}`);
    expect(normalizeSpotifyUri(`https://open.spotify.com/intl-fr/track/${ID}?si=abc`)).toBe(`spotify:track:${ID}`);
    expect(normalizeSpotifyUri(ID)).toBe(`spotify:track:${ID}`);
    expect(normalizeSpotifyUri('spotify:album:' + ID)).toBeUndefined();
    expect(normalizeSpotifyUri('musique/a.mp3')).toBeUndefined();
  });

  it('lit la colonne Track URI (Exportify) et les liens placés dans « fichier »', () => {
    const csv = `"Track URI","Track Name","Artist Name(s)","Duration (ms)","Tempo"\n"spotify:track:${ID}","A","B",200000,170\n`;
    expect(parseLibraryCsv(csv).songs[0].spotifyUri).toBe(`spotify:track:${ID}`);
    const csv2 = `title,bpm,duration,file\nA,170,3:00,https://open.spotify.com/track/${ID}\nB,170,3:00,b.mp3\n`;
    const songs = parseLibraryCsv(csv2).songs;
    expect(songs[0]).toMatchObject({ spotifyUri: `spotify:track:${ID}`, file: undefined });
    expect(songs[1]).toMatchObject({ spotifyUri: undefined, file: 'b.mp3' });
  });
});

describe('correspondance avec les résultats de recherche', () => {
  const c = (name: string, artists: string[], durationS = 200, uri = name) => ({ uri, name, artists, durationMs: durationS * 1000 });

  it('nettoie les titres', () => {
    expect(cleanTitle('Around the World - Radio Edit')).toBe('around the world');
    expect(cleanTitle('Song (feat. X) [Remastered]')).toBe('song');
  });

  it('prend le bon morceau et écarte les homonymes', () => {
    const s = song('Around the World', 'Daft Punk', 429);
    const best = pickBestTrack(s, [
      c('Around the World', ['Red Hot Chili Peppers'], 238, 'rhcp'),
      c('Around the World - Radio Edit', ['Daft Punk'], 240, 'edit'),
      c('Around the World', ['Daft Punk'], 429, 'album'),
    ]);
    expect(best?.uri).toBe('album');
  });

  it('refuse une correspondance douteuse', () => {
    expect(pickBestTrack(song('Run', 'Band'), [c('Running Up That Hill', ['Band'])])).toBeUndefined();
    expect(pickBestTrack(song('Run', 'Band'), [c('Run', ['Autre'])])).toBeUndefined();
  });

  it('construit la requête de recherche', () => {
    expect(searchQuery(song('Titre "x" (Live)', 'Artiste'))).toBe('track:Titre x artist:Artiste');
    expect(searchQuery(song('T', 'Artiste inconnu'))).toBe('track:T');
  });
});

describe('canStretch', () => {
  it('interdit l’ajustement de tempo pour les morceaux non étirables', () => {
    const plan = planRun([{ startDist: 0, endDist: 3000, length: 3000, eleStart: 0, eleEnd: 0, grade: 0 }], {
      targetPace: 300,
      baseCadence: 170,
    });
    const lib = [song('near', 'x', 2000, { bpm: 166 }), song('exact', 'x', 2000, { bpm: 170 })];
    const free = generatePlaylist(plan, [lib[0]], { maxStretch: 0.04 });
    expect(free.entries[0].playbackRate).not.toBe(1);
    const locked = generatePlaylist(plan, lib, { maxStretch: 0.04, canStretch: () => false });
    expect(locked.entries[0]).toMatchObject({ playbackRate: 1 });
    expect(locked.entries[0].song.id).toBe('exact');
  });
});

// ---------- Client Spotify (fetch simulé) ----------

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

const CLIENT = '0123456789abcdef0123456789abcdef';

async function loggedIn(handler: Handler) {
  const store = memoryStore();
  const session = memoryStore();
  const { f, calls } = fakeFetch(handler);
  const auth = new SpotifyAuth(store, session, f);
  auth.clientId = CLIENT;
  store.setItem('runbpm.spotify.tokens', JSON.stringify({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3_600_000 }));
  return { auth, store, calls, api: new SpotifyApi(auth, f, async () => {}) };
}

describe('SpotifyAuth', () => {
  it('calcule le code challenge PKCE (SHA-256, base64url)', async () => {
    const expected = createHash('sha256').update('verifier').digest('base64url');
    expect(await codeChallenge('verifier')).toBe(expected);
  });

  it('construit l’URL d’autorisation puis échange le code', async () => {
    const store = memoryStore();
    const session = memoryStore();
    const { f, calls } = fakeFetch(() => json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
    const auth = new SpotifyAuth(store, session, f);
    auth.clientId = CLIENT;
    const url = new URL(await auth.authorizeUrl('http://127.0.0.1:5173/'));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('streaming');
    const state = url.searchParams.get('state')!;

    await expect(auth.handleRedirect(`?code=C&state=wrong`, 'http://127.0.0.1:5173/')).rejects.toThrow(/état invalide/);
    await auth.authorizeUrl('http://127.0.0.1:5173/');
    const state2 = session.getItem('runbpm.spotify.state')!;
    expect(state2).not.toBe(state);
    expect(await auth.handleRedirect(`?code=C&state=${state2}`, 'http://127.0.0.1:5173/')).toBe(true);
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toHaveLength(64);
    expect(await auth.accessToken()).toBe('AT');
    expect(await auth.handleRedirect('', 'x')).toBe(false);
  });

  it('refuse un Client ID mal formé', async () => {
    const auth = new SpotifyAuth(memoryStore(), memoryStore(), fakeFetch(() => json(200, {})).f);
    auth.clientId = 'abc';
    await expect(auth.authorizeUrl('http://127.0.0.1/')).rejects.toThrow(/Client ID/);
  });

  it('rafraîchit un jeton expiré et conserve le refresh token', async () => {
    const { auth, store, calls } = await loggedIn(() => json(200, { access_token: 'A2', expires_in: 3600 }));
    store.setItem('runbpm.spotify.tokens', JSON.stringify({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() - 1 }));
    expect(await auth.accessToken()).toBe('A2');
    expect(new URLSearchParams(String(calls[0].init.body)).get('grant_type')).toBe('refresh_token');
    expect(JSON.parse(store.getItem('runbpm.spotify.tokens')!).refreshToken).toBe('R1');
  });

  it('changer de Client ID déconnecte', async () => {
    const { auth } = await loggedIn(() => json(200, {}));
    expect(auth.loggedIn).toBe(true);
    auth.clientId = 'ffffffffffffffffffffffffffffffff';
    expect(auth.loggedIn).toBe(false);
  });
});

describe('SpotifyApi', () => {
  it('réessaie après un 429 et après un 401 (jeton rafraîchi)', async () => {
    let n = 0;
    const { api, calls } = await loggedIn((url) => {
      if (url.includes('/api/token')) return json(200, { access_token: 'A2', expires_in: 3600 });
      n++;
      if (n === 1) return json(429, { error: { message: 'slow down' } }, { 'Retry-After': '1' });
      if (n === 2) return json(401, { error: { message: 'expired' } });
      return json(200, { id: 'u1', display_name: 'Coureur' });
    });
    expect(await api.me()).toEqual({ id: 'u1', name: 'Coureur' });
    const apiCalls = calls.filter((c) => c.url.includes('/v1/me'));
    expect(apiCalls).toHaveLength(3);
    expect((apiCalls[2].init.headers as Record<string, string>).Authorization).toBe('Bearer A2');
  });

  it('traduit un 403 en message explicite', async () => {
    const { api } = await loggedIn(() => json(403, { error: { message: 'Premium required' } }));
    const err = await api.pause().catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.message).toMatch(/Premium/);
  });

  it('recherche des morceaux', async () => {
    const { api, calls } = await loggedIn(() =>
      json(200, { tracks: { items: [{ uri: 'spotify:track:x', name: 'N', duration_ms: 1000, artists: [{ name: 'A' }] }] } }),
    );
    expect(await api.searchTracks('track:N artist:A', 50)).toEqual([{ uri: 'spotify:track:x', name: 'N', artists: ['A'], durationMs: 1000 }]);
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('10');
  });

  it('crée une playlist et ajoute les morceaux par lots de 100, dans l’ordre', async () => {
    const { api, calls } = await loggedIn((url) =>
      url.endsWith('/me/playlists') ? json(201, { id: 'PL', external_urls: { spotify: 'https://open.spotify.com/playlist/PL' } }) : json(201, { snapshot_id: 's' }),
    );
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`);
    const res = await api.createPlaylist('Nom', 'Desc', uris);
    expect(res.url).toBe('https://open.spotify.com/playlist/PL');
    const adds = calls.filter((c) => c.url.endsWith('/playlists/PL/items'));
    expect(adds.map((c) => JSON.parse(String(c.init.body)).uris.length)).toEqual([100, 50]);
    expect(JSON.parse(String(adds[1].init.body)).uris[0]).toBe('spotify:track:100');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ name: 'Nom', public: false });
  });

  it('pilote la lecture sur un appareil', async () => {
    const { api, calls } = await loggedIn(() => new Response(null, { status: 204 }));
    await api.play('dev 1', { uris: ['spotify:track:x'], positionMs: 1500.4 });
    expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev%201');
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ uris: ['spotify:track:x'], position_ms: 1500 });
    expect(await api.playbackState()).toBeUndefined();
  });
});
