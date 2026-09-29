import { describe, expect, it } from 'vitest';
import { buildRoute } from '../src/core/route';
import { elevationStats, smooth, splitSections } from '../src/core/sections';

const profileRoute = (pts: [number, number][]) => buildRoute('t', pts.map(([dist, ele]) => ({ dist, ele })));

describe('smooth', () => {
  it('conserve une série constante', () => {
    expect(smooth([5, 5, 5, 5], 2)).toEqual([5, 5, 5, 5]);
  });
});

describe('splitSections', () => {
  it('isole plat, montée et descente', () => {
    const route = profileRoute([
      [0, 100],
      [2000, 100],
      [3000, 160], // +6 %
      [4000, 100], // -6 %
      [6000, 100],
    ]);
    const secs = splitSections(route);
    const grades = secs.map((s) => s.grade * 100);
    // Le lissage adoucit les transitions : la pente reconstituée reste proche de ±6 %.
    expect(Math.max(...grades)).toBeGreaterThan(5);
    expect(Math.min(...grades)).toBeLessThan(-5);
    expect(Math.abs(grades[0])).toBeLessThan(0.5);
    expect(secs[0].startDist).toBe(0);
    expect(secs[secs.length - 1].endDist).toBeCloseTo(6000);
    for (const s of secs) expect(s.length).toBeGreaterThanOrEqual(250);
  });

  it('les sections sont contiguës', () => {
    const route = profileRoute([[0, 0], [700, 20], [900, 5], [3000, 40]]);
    const secs = splitSections(route);
    for (let i = 1; i < secs.length; i++) expect(secs[i].startDist).toBe(secs[i - 1].endDist);
  });

  it('calcule D+ et D-', () => {
    const route = profileRoute([[0, 0], [1000, 50], [2000, 0]]);
    const { gain, loss } = elevationStats(splitSections(route, { smoothWindow: 0 }));
    expect(gain).toBeCloseTo(50, 0);
    expect(loss).toBeCloseTo(50, 0);
  });

  it('un parcours plus court que la longueur minimale donne une seule section', () => {
    expect(splitSections(profileRoute([[0, 0], [100, 10]]))).toHaveLength(1);
  });
});
