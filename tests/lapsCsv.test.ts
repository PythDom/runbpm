import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readActivity, segmentsFromLapsCsv } from '../src/core/activity';
import { calibrate, predictCadence } from '../src/core/calibration';

const dir = new URL('./fixtures/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.startsWith('coros-laps-'));

describe('calibrage par export CSV des tours (COROS)', () => {
  it('lit chaque tour : vitesse, pente nette, cadence doublée, poids plafonné', () => {
    const text = readFileSync(new URL('coros-laps-42KM-S5-3-En_.csv', dir), 'utf8');
    const segs = segmentsFromLapsCsv(text);
    expect(segs).toHaveLength(12); // ligne « Summary » ignorée
    expect(segs[0].cadence).toBe(164); // 82 (un pied) × 2
    expect(segs[0].speedKmh).toBeCloseTo(3.01 / (20 / 60), 2);
    expect(segs[0].weight).toBe(300); // tour de 20 min : compte pour 5 min
    expect(segs[1].weight).toBe(15);
    expect(segs[1].speedKmh).toBeGreaterThan(16); // sprint de 15 s
  });

  it('readActivity reconnaît le CSV ; distance réelle', () => {
    const act = readActivity('sortie.csv', new Uint8Array(readFileSync(new URL('coros-laps-42KM-S6-5-So_.csv', dir))));
    expect(act.segments).toHaveLength(12);
    expect(act.distanceKm).toBeCloseTo(11.17, 1);
    expect(() => readActivity('vide.csv', new TextEncoder().encode('a,b\n1,2'))).toThrow(/non reconnu/);
  });

  it('quatre sorties : conversion allure → cadence cohérente avec les tours', () => {
    const segments = files.flatMap((f) => segmentsFromLapsCsv(readFileSync(new URL(f, dir), 'utf8')));
    expect(segments.length).toBe(50);
    const m = calibrate(segments);
    const at = (pace: number) => predictCadence(m, 3600 / pace);
    expect(at(360)).toBeGreaterThan(166);
    expect(at(360)).toBeLessThan(174); // ≈ 170 à 6:00 /km
    expect(at(210)).toBeGreaterThan(at(360) + 8); // nettement plus haut en sprint (3:30 /km)
    expect(m.rmse).toBeLessThan(5);
  });
});
