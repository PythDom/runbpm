import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5 } from '../src/core/md5';
import { makeCredentials, normalizeServerUrl, SubsonicClient, SubsonicError } from '../src/services/subsonic';

describe('md5', () => {
  it('vecteurs de la RFC 1321', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
  it('identique à Node pour de l’UTF-8 et des longueurs variées', () => {
    for (const s of ['sesame', 'mot de passe éè', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), '🏃'.repeat(40)]) {
      expect(md5(s)).toBe(createHash('md5').update(s).digest('hex'));
    }
  });
});

type Handler = (url: URL, init: RequestInit) => Response;
function client(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { c: new SubsonicClient(makeCredentials('nas.local:4533/app/#/album', 'coureur', 'sesame', 'c19b2d'), f), calls };
}
const ok = (payload: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...payload } }), { status: 200 });

describe('SubsonicClient', () => {
  it('normalise l’adresse et signe les requêtes par jeton', async () => {
    expect(normalizeServerUrl(' https://music.example.org/ ')).toBe('https://music.example.org');
    const { c, calls } = client(() => ok({ type: 'navidrome', serverVersion: '0.63.0' }));
    expect(await c.ping()).toEqual({ serverName: 'navidrome', version: '0.63.0' });
    const u = calls[0].url;
    expect(u.origin + u.pathname).toBe('http://nas.local:4533/rest/ping');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ u: 'coureur', s: 'c19b2d', t: md5('sesamec19b2d'), c: 'RunBPM', f: 'json' });
    expect(u.searchParams.has('p')).toBe(false);
  });

  it('traduit les erreurs Subsonic et réseau', async () => {
    const bad = client(() => new Response(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } })));
    await expect(bad.c.ping()).rejects.toThrow('Identifiant ou mot de passe incorrect.');
    const down = new SubsonicClient(makeCredentials('x', 'u', 'p'), (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(down.ping()).rejects.toBeInstanceOf(SubsonicError);
    const notSubsonic = client(() => new Response('<html>', { status: 200 }));
    await expect(notSubsonic.c.ping()).rejects.toThrow(/Subsonic/);
  });

  it('parcourt toute la bibliothèque par pages', async () => {
    const all = Array.from({ length: 1203 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, artist: 'A', duration: 200, bpm: i % 2 ? 170 : 0 }));
    const { c, calls } = client((u) => {
      const off = Number(u.searchParams.get('songOffset'));
      const n = Number(u.searchParams.get('songCount'));
      return ok({ searchResult3: { song: all.slice(off, off + n) } });
    });
    const pages: number[] = [];
    let first;
    for await (const page of c.allSongs()) {
      pages.push(page.length);
      first ??= page[0];
    }
    expect(pages).toEqual([500, 500, 203]);
    expect(calls[0].url.searchParams.get('query')).toBe('');
    expect(first).toMatchObject({ id: 's0', bpm: undefined });
  });

  it('lit une plage d’octets, même si le serveur ignore Range', async () => {
    const file = Uint8Array.from({ length: 100 }, (_, i) => i);
    const ranged = client((_u, init) => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!;
      return new Response(file.slice(Number(a), Number(b) + 1), { status: 206 });
    });
    expect(Array.from(await ranged.c.readRange('s1', 10, 5))).toEqual([10, 11, 12, 13, 14]);
    expect(ranged.calls[0].url.searchParams.get('format')).toBe('raw');
    const full = client(() => new Response(file, { status: 200 }));
    expect(Array.from(await full.c.readRange('s1', 98, 5))).toEqual([98, 99]);
  });

  it('crée une playlist par lots de 100', async () => {
    const { c, calls } = client((u) => (u.pathname.endsWith('createPlaylist') ? ok({ playlist: { id: 'pl1' } }) : ok()));
    const ids = Array.from({ length: 230 }, (_, i) => `s${i}`);
    expect(await c.createPlaylist('Ma course', ids)).toBe('pl1');
    expect(calls.map((x) => x.url.pathname.split('/').pop())).toEqual(['createPlaylist', 'updatePlaylist', 'updatePlaylist']);
    expect(calls[0].url.searchParams.getAll('songId')).toHaveLength(100);
    expect(calls[2].url.searchParams.getAll('songIdToAdd')).toEqual(ids.slice(200));
  });
});
