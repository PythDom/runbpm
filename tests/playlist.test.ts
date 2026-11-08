import { describe, expect, it } from 'vitest';
import { demoLibrary } from '../src/core/demo';
import { toCsv, toM3U, toTransferCsv, toTransferText } from '../src/core/export';
import type { Song } from '../src/core/library';
import { planRun } from '../src/core/pacing';
import { generatePlaylist } from '../src/core/playlist';
import type { Section } from '../src/core/sections';

const sec = (startDist: number, length: number, grade: number): Section => ({
  startDist,
  endDist: startDist + length,
  length,
  eleStart: 0,
  eleEnd: grade * length,
  grade,
});
const song = (id: string, bpm: number, duration = 200): Song => ({ id, title: id, artist: 'x', bpm, duration });

describe('generatePlaylist', () => {
  const flat = planRun([sec(0, 5000, 0)], { targetPace: 300, baseCadence: 170 }); // 25 min à 170

  it('choisit les morceaux au bon tempo et couvre toute la course', () => {
    const lib = [song('bad', 130), ...Array.from({ length: 10 }, (_, i) => song(`ok${i}`, 170)), song('bad2', 200)];
    const p = generatePlaylist(flat, lib, { maxStretch: 0 });
    expect(p.entries.every((e) => e.song.bpm === 170)).toBe(true);
    expect(p.totalDuration).toBeGreaterThanOrEqual(flat.totalTime - 1);
    expect(p.matchRatio).toBe(1);
    expect(new Set(p.entries.map((e) => e.song.id)).size).toBe(p.entries.length);
  });

  it('utilise le mi-tempo', () => {
    const p = generatePlaylist(flat, [song('half', 85, 2000)], { maxStretch: 0 });
    expect(p.entries[0]).toMatchObject({ multiplier: 2, effectiveCadence: 170 });
    const none = generatePlaylist(flat, [song('half', 85, 2000)], { maxStretch: 0, allowHalfTime: false });
    expect(none.entries[0].multiplier).toBe(1);
    expect(none.warnings.some((w) => w.includes('hors tolérance'))).toBe(true);
  });

  it('ajuste la vitesse de lecture dans la limite permise', () => {
    const p = generatePlaylist(flat, [song('a', 166, 2000)], { maxStretch: 0.04 });
    expect(p.entries[0].playbackRate).toBeCloseTo(170 / 166, 3);
    expect(p.entries[0].effectiveCadence).toBeCloseTo(170, 0);
    const capped = generatePlaylist(flat, [song('a', 150, 2000)], { maxStretch: 0.04 });
    expect(capped.entries[0].playbackRate).toBeCloseTo(1.04);
  });

  it('suit les changements de cadence du parcours', () => {
    const plan = planRun([sec(0, 3000, 0), sec(3000, 3000, 0.1)], {
      targetPace: 300,
      baseCadence: 170,
      uphillSensitivity: 1,
    });
    const lib = [
      ...Array.from({ length: 6 }, (_, i) => song(`flat${i}`, 170, 150)),
      ...Array.from({ length: 6 }, (_, i) => song(`hill${i}`, 180, 150)),
    ];
    const p = generatePlaylist(plan, lib, { maxStretch: 0 });
    const early = p.entries.filter((e) => e.endTime <= 900);
    const late = p.entries.filter((e) => e.startTime >= 900);
    expect(early.every((e) => e.song.bpm === 170)).toBe(true);
    expect(late.every((e) => e.song.bpm === 180)).toBe(true);
  });

  it('signale une bibliothèque épuisée, ou répète si autorisé', () => {
    const lib = [song('a', 170, 200)];
    expect(generatePlaylist(flat, lib).warnings[0]).toMatch(/épuisée/);
    const rep = generatePlaylist(flat, lib, { allowRepeat: true });
    expect(rep.entries.length).toBeGreaterThan(1);
    expect(rep.entries[1].repeated).toBe(true);
  });

  it('est déterministe pour une graine donnée', () => {
    const lib = demoLibrary();
    const a = generatePlaylist(flat, lib, { seed: 3 }).entries.map((e) => e.song.id);
    const b = generatePlaylist(flat, lib, { seed: 3 }).entries.map((e) => e.song.id);
    expect(a).toEqual(b);
  });
});

describe('exports', () => {
  it('produit un M3U et un CSV', () => {
    const plan = planRun([sec(0, 1000, 0)], { targetPace: 300, baseCadence: 170 });
    const p = generatePlaylist(plan, [{ ...song('a', 168, 400), file: 'music/a.mp3', title: 'Titre, "cité"' }]);
    const m3u = toM3U(p);
    expect(m3u.startsWith('#EXTM3U')).toBe(true);
    expect(m3u).toContain('music/a.mp3');
    expect(m3u).toContain('#RUNBPM:rate=');
    expect(toCsv(p)).toContain('"Titre, ""cité"""');
    expect(toTransferText(p)).toBe('x - Titre, "cité"\n');
    expect(toTransferCsv(p)).toBe('Track name,Artist name\n"Titre, ""cité""",x\n');
  });
});

describe('variété', () => {
  // 60 morceaux tous dans la tolérance d'une course à plat (cadence constante).
  const flat: Section[] = [{ startDist: 0, endDist: 8000, length: 8000, eleStart: 0, eleEnd: 0, grade: 0 }];
  const plan = planRun(flat, { targetPace: 330, mode: 'pace', baseCadence: 172 });
  const lib: Song[] = Array.from({ length: 60 }, (_, i) => ({ id: `v${i}`, title: `V${i}`, artist: 'A', bpm: 170 + (i % 5), duration: 200 }));
  const ids = (p: ReturnType<typeof generatePlaylist>) => p.entries.map((e) => e.song.id);

  it('tire au sort parmi les morceaux dans la tolérance', () => {
    const a = ids(generatePlaylist(plan, lib, { seed: 1 }));
    const b = ids(generatePlaylist(plan, lib, { seed: 2 }));
    const common = a.filter((id) => b.includes(id)).length;
    expect(common / a.length).toBeLessThan(0.6);
    // Les morceaux choisis couvrent largement les tempos disponibles, pas seulement le plus exact.
    expect(new Set(generatePlaylist(plan, lib, { seed: 1 }).entries.map((e) => e.song.bpm)).size).toBeGreaterThanOrEqual(3);
  });

  it('évite les morceaux écoutés récemment', () => {
    const first = ids(generatePlaylist(plan, lib, { seed: 7 }));
    const recent = new Map(first.map((id) => [id, 1]));
    const next = ids(generatePlaylist(plan, lib, { seed: 7, recent }));
    expect(next.filter((id) => recent.has(id)).length).toBe(0);
  });

  it('garde la tolérance malgré le tirage', () => {
    const p = generatePlaylist(plan, lib, { seed: 3 });
    expect(p.matchRatio).toBeGreaterThan(0.97);
  });
});
