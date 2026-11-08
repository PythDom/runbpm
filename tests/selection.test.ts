import { describe, expect, it, vi } from 'vitest';
import type { Song } from '../src/core/library';
import type { SharedDb } from '../src/services/sharedDb';
import { Selection } from '../src/ui/selection';

const song = (id: string, navidromeId?: string): Song => ({ id, title: id, artist: 'A', duration: 200, bpm: 170, navidromeId });

function fakeRemote(initial: string[]) {
  let saved = initial;
  return {
    remote: { list: async () => saved, saveList: vi.fn(async (_name: string, ids: string[]) => void (saved = ids)) } as unknown as SharedDb,
    saved: () => saved,
  };
}

describe('Selection', () => {
  it('coche par identifiant Navidrome et garde un morceau coché avant son lien au serveur', () => {
    const lib = [song('f1'), song('nd-9', '9')];
    const sel = new Selection(() => lib);
    sel.set(lib, true);
    expect(sel.count(lib)).toBe(2);
    lib[0].navidromeId = '4';
    expect(sel.has(lib[0])).toBe(true);
    sel.set([lib[0]], false);
    expect(sel.has(lib[0])).toBe(false);
  });

  it('serveur vide : envoie la sélection locale (morceaux Navidrome seulement)', async () => {
    vi.useFakeTimers();
    const lib = [song('local'), song('nd-1', '1')];
    const sel = new Selection(() => lib);
    sel.set(lib, true);
    const r = fakeRemote([]);
    await sel.attach(r.remote);
    expect(r.saved()).toEqual(['1']);
    vi.useRealTimers();
  });

  it('serveur non vide : il fait foi, y compris pour des morceaux absents d’ici', async () => {
    vi.useFakeTimers();
    const lib = [song('local'), song('nd-1', '1'), song('nd-2', '2')];
    const sel = new Selection(() => lib);
    sel.set(lib, true);
    const r = fakeRemote(['2', '99']);
    await sel.attach(r.remote);
    expect(lib.map((s) => sel.has(s))).toEqual([true, false, true]);
    sel.set([lib[1]], true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(new Set(r.saved())).toEqual(new Set(['2', '99', '1']));
    vi.useRealTimers();
  });
});

describe('Exclusions', () => {
  it('liste séparée, stockée à part et envoyée au serveur sous son nom', async () => {
    vi.useFakeTimers();
    const lib = [song('nd-1', '1'), song('nd-2', '2')];
    const ex = new Selection(() => lib, undefined, 'excluded');
    const calls: [string, string[]][] = [];
    const remote = { list: async () => [], saveList: vi.fn(async (name: string, ids: string[]) => void calls.push([name, ids])) } as unknown as SharedDb;
    await ex.attach(remote);
    ex.set([lib[1]], true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([['excluded', ['2']]]);
    vi.useRealTimers();
  });

  it('serveur ancien (liste inconnue) : reste sur l’appareil, sans erreurs à chaque changement', async () => {
    vi.useFakeTimers();
    const lib = [song('nd-1', '1')];
    const errors: string[] = [];
    const ex = new Selection(() => lib, (m) => errors.push(m), 'excluded');
    const remote = { list: async () => { throw new Error('404'); }, saveList: vi.fn() } as unknown as SharedDb;
    await expect(ex.attach(remote)).rejects.toThrow();
    ex.set(lib, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ex.has(lib[0])).toBe(true);
    expect((remote as unknown as { saveList: ReturnType<typeof vi.fn> }).saveList).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    vi.useRealTimers();
  });
});
