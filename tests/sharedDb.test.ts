import { describe, expect, it, vi } from 'vitest';
import type { Song } from '../src/core/library';
import { mergeShared, normalizeServerUrl, SharedDb, type SharedSong } from '../src/services/sharedDb';

const remote = (id: string, bpm: number, extra: Partial<SharedSong> = {}): SharedSong => ({
  id, title: `T${id}`, artist: 'A', duration: 200, bpm, bpmSource: 'analyse', confidence: 0.5, ...extra,
});
const local = (id: string, bpm: number, extra: Partial<Song> = {}): Song => ({
  id: `nd-${id}`, title: `T${id}`, artist: 'A', duration: 200, bpm, bpmSource: 'analyse', navidromeId: id, ...extra,
});

describe('mergeShared', () => {
  it('ajoute les morceaux du serveur et adopte leurs BPM', () => {
    const r = mergeShared([local('1', 160)], [remote('1', 170), remote('2', 88)]);
    expect(r.library.map((s) => [s.id, s.bpm])).toEqual([['nd-1', 170], ['nd-2', 88]]);
    expect(r.received).toBe(2);
    expect(r.toUpload).toEqual([]);
  });

  it('envoie les morceaux absents du serveur et les corrections manuelles locales', () => {
    const r = mergeShared([local('1', 85, { bpmSource: 'manuel' }), local('3', 175)], [remote('1', 170)]);
    expect(r.library.find((s) => s.id === 'nd-1')?.bpm).toBe(85);
    expect(r.toUpload.map((s) => [s.id, s.bpm, s.bpmSource])).toEqual([['1', 85, 'manuel'], ['3', 175, 'analyse']]);
  });

  it('une correction manuelle partagée l’emporte', () => {
    const r = mergeShared([local('1', 85, { bpmSource: 'manuel' })], [remote('1', 172, { bpmSource: 'manuel' })]);
    expect(r.library[0]).toMatchObject({ bpm: 172, bpmSource: 'manuel' });
  });

  it('un morceau douteux corrigé ailleurs ne l’est plus ici', () => {
    const r = mergeShared([local('1', 86, { confidence: 0.3 })], [remote('1', 172, { bpmSource: 'manuel', confidence: undefined })]);
    expect(r.library[0]).toMatchObject({ bpm: 172, bpmSource: 'manuel' });
    expect(r.library[0].confidence).toBeUndefined();
  });

  it('relie un morceau local de même titre et artiste sans le dupliquer', () => {
    const file: Song = { id: 'f1', title: 'T7', artist: 'A', duration: 200, bpm: 150, bpmSource: 'analyse', fileKey: 'x' };
    const r = mergeShared([file], [remote('7', 176)]);
    expect(r.library).toHaveLength(1);
    expect(r.library[0]).toMatchObject({ id: 'f1', navidromeId: '7', bpm: 176 });
  });
});

describe('SharedDb', () => {
  it('normalise l’adresse du serveur', () => {
    expect(normalizeServerUrl('moi.pythonanywhere.com/')).toBe('https://moi.pythonanywhere.com');
    expect(normalizeServerUrl('https://moi.pythonanywhere.com/api/')).toBe('https://moi.pythonanywhere.com');
    expect(normalizeServerUrl('127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
    expect(normalizeServerUrl('192.168.1.5:8000')).toBe('http://192.168.1.5:8000');
  });

  it('transmet le code d’accès dans un en-tête', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ songs: [] }), { headers: { 'Content-Type': 'application/json' } }));
    const db = new SharedDb('moi.pythonanywhere.com', 'alice:s3cret', f as unknown as typeof fetch);
    await db.songs();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://moi.pythonanywhere.com/api/songs');
    expect((init.headers as Record<string, string>)['X-RunBPM-Key']).toBe('alice:s3cret');
    expect(db.user).toBe('alice');
  });

  it('health : undefined quand l’API n’est pas servie', async () => {
    const html = vi.fn(async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
    expect(await SharedDb.health('x.org', html as unknown as typeof fetch)).toBeUndefined();
    const down = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(await SharedDb.health('x.org', down as unknown as typeof fetch)).toBeUndefined();
  });

  it('upsert par lots', async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const n = JSON.parse(String(init.body)).songs.length;
      return new Response(JSON.stringify({ added: n, updated: 0, total: n }));
    });
    const db = new SharedDb('x.org', 'u:k', f as unknown as typeof fetch);
    const r = await db.upsert(Array.from({ length: 1201 }, (_, i) => remote(String(i), 170)));
    expect(f).toHaveBeenCalledTimes(3);
    expect(r.added).toBe(1201);
  });
});
