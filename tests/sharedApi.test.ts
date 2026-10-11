import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../server/api.mjs';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const USERS: Record<string, string> = { alice: 'pw-a', bob: 'pw-b' };

/** Faux Navidrome : /rest/ping valide le jeton md5(mot de passe + sel). */
function fakeNavidrome() {
  let pings = 0;
  const f = (async (input: RequestInfo | URL) => {
    pings++;
    const q = new URL(String(input)).searchParams;
    const pw = USERS[q.get('u') ?? ''];
    const ok = pw !== undefined && q.get('t') === md5(pw + q.get('s'));
    return new Response(JSON.stringify({ 'subsonic-response': ok ? { status: 'ok' } : { status: 'failed', error: { code: 40 } } }));
  }) as typeof fetch;
  return { f, pings: () => pings };
}

const auth = (u: string, pw: string, s = 'sel123') => ({ 'X-RunBPM-Auth': new URLSearchParams({ u, t: md5(pw + s), s }).toString() });

let server: Server | undefined;
async function start(opts: { navidromeUrl?: string; dataFile?: string; fetchImpl?: typeof fetch }) {
  const dataFile = opts.dataFile ?? join(mkdtempSync(join(tmpdir(), 'runbpm-')), 'db.json');
  const api = createApi({ dataFile, navidromeUrl: opts.navidromeUrl, fetchImpl: opts.fetchImpl, saveDelayMs: 0 });
  server = createServer((req, res) => void api.handle(req, res));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { api, call, dataFile };
}
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const song = (id: string, bpm: number, extra = {}) => ({ id, title: `T${id}`, artist: 'A', duration: 200, bpm, bpmSource: 'analyse', confidence: 0.6, ...extra });

describe('base partagée', () => {
  it('sans NAVIDROME_URL : santé OK mais pas d’accès aux données', async () => {
    const { call } = await start({});
    expect((await call('GET', '/api/health')).body).toMatchObject({ ok: true, configured: false });
    expect((await call('GET', '/api/songs', auth('alice', 'pw-a'))).status).toBe(503);
  });

  it('authentifie auprès de Navidrome et met en cache', async () => {
    const nd = fakeNavidrome();
    const { call } = await start({ navidromeUrl: 'http://nd.local:4533/', fetchImpl: nd.f });
    expect((await call('GET', '/api/songs')).status).toBe(401);
    expect((await call('GET', '/api/songs', auth('alice', 'faux'))).status).toBe(401);
    expect((await call('GET', '/api/songs', auth('alice', 'pw-a'))).status).toBe(200);
    expect((await call('GET', '/api/songs', auth('alice', 'pw-a'))).status).toBe(200);
    expect(nd.pings()).toBe(2); // sans identifiants : pas d’appel ; 1 refus + 1 succès, puis cache
  });

  it('ajoute, met à jour, et garde les corrections manuelles face à une nouvelle analyse', async () => {
    const nd = fakeNavidrome();
    const { call } = await start({ navidromeUrl: 'http://nd', fetchImpl: nd.f });
    const a = auth('alice', 'pw-a');
    const r1 = await call('POST', '/api/songs', a, { songs: [song('1', 170), song('2', 88), { id: 'x', bpm: 999 }] });
    expect(r1.body).toMatchObject({ added: 2, updated: 0, total: 2 });
    const p = await call('PATCH', '/api/songs/1', auth('bob', 'pw-b'), { bpm: 85 });
    expect(p.body.song).toMatchObject({ bpm: 85, bpmSource: 'manuel', updatedBy: 'bob' });
    const r2 = await call('POST', '/api/songs', a, { songs: [song('1', 171, { title: 'Nouveau titre' }), song('2', 89)] });
    expect(r2.body).toMatchObject({ added: 0, updated: 1, kept: 1 });
    const list = (await call('GET', '/api/songs', a)).body.songs as { id: string; bpm: number; title: string }[];
    expect(list.find((s) => s.id === '1')).toMatchObject({ bpm: 85, title: 'Nouveau titre' });
    expect(list.find((s) => s.id === '2')).toMatchObject({ bpm: 89 });
    const r3 = await call('POST', '/api/songs', a, { songs: [song('2', 89)] });
    expect(r3.body).toMatchObject({ updated: 0, unchanged: 1 });
    expect((await call('PATCH', '/api/songs/1', a, { bpm: 20 })).status).toBe(400);
    expect((await call('PATCH', '/api/songs/inconnu', a, { bpm: 170 })).status).toBe(404);
  });

  it('une sélection par utilisateur', async () => {
    const nd = fakeNavidrome();
    const { call } = await start({ navidromeUrl: 'http://nd', fetchImpl: nd.f });
    await call('PUT', '/api/selection', auth('alice', 'pw-a'), { selected: ['1', '2', '2', 3] });
    await call('PUT', '/api/selection', auth('bob', 'pw-b'), { selected: ['9'] });
    expect((await call('GET', '/api/selection', auth('alice', 'pw-a'))).body).toEqual({ user: 'alice', selected: ['1', '2'] });
    expect((await call('GET', '/api/selection', auth('bob', 'pw-b'))).body).toEqual({ user: 'bob', selected: ['9'] });
  });

  it('enregistre dans le fichier et relit après redémarrage', async () => {
    const nd = fakeNavidrome();
    const first = await start({ navidromeUrl: 'http://nd', fetchImpl: nd.f });
    await first.call('POST', '/api/songs', auth('alice', 'pw-a'), { songs: [song('42', 176)] });
    await first.api.flush();
    expect(JSON.parse(readFileSync(first.dataFile, 'utf8')).songs['42'].bpm).toBe(176);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const second = await start({ navidromeUrl: 'http://nd', fetchImpl: nd.f, dataFile: first.dataFile });
    expect((await second.call('GET', '/api/health')).body.songs).toBe(1);
  });
});
