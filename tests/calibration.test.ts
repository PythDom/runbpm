import { describe, expect, it } from 'vitest';
import { readActivity, samplesFromTcx, segmentActivity, toStepsPerMinute } from '../src/core/activity';
import { calibrate, DEFAULT_MODEL, predictCadence } from '../src/core/calibration';
import { fitCrc, parseFit } from '../src/core/fit';
import { planRun } from '../src/core/pacing';
import type { Section } from '../src/core/sections';
import { simulateRun, writeFit } from './helpers/fitWriter';

const LAW = { k0: 128, kv: 4, up: 1.0, down: 0.5 };

describe('lecture FIT', () => {
  it('CRC de référence', () => {
    expect(fitCrc(new TextEncoder().encode('123456789'))).toBe(0xbb3d); // CRC-16/ARC
  });

  it('lit les points, le sport, les horodatages compressés et le gros-boutisme', () => {
    const pts = simulateRun(LAW, { minutes: 5 });
    for (const variant of [{}, { bigEndianRecords: true }, { compressEvery: 3 }]) {
      const fit = parseFit(writeFit(pts, variant));
      expect(fit.crcMismatch).toBe(false);
      expect(fit.sport).toBe(1);
      expect(fit.records).toHaveLength(pts.length);
      expect(fit.records.map((r) => r.timestamp! - fit.records[0].timestamp!).slice(0, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(fit.records[10].distance).toBeCloseTo(pts[10].dist, 1);
      expect(fit.records[10].altitude).toBeCloseTo(pts[10].alt, 0);
    }
    const r = parseFit(writeFit(pts)).records[1];
    expect(r.cadence).toBeCloseTo(pts[1].strides, 1);
    expect(r.speed).toBeCloseTo(pts[1].speed, 2);
  });

  it('signale un CRC faux et refuse ce qui n’est pas du FIT', () => {
    expect(parseFit(writeFit(simulateRun(LAW, { minutes: 1 }), { corruptCrc: true })).crcMismatch).toBe(true);
    expect(() => parseFit(new TextEncoder().encode('pas un fichier FIT du tout'))).toThrow(/FIT/);
  });
});

describe('activité → tronçons', () => {
  it('double la cadence « un pied »', () => {
    expect(toStepsPerMinute([85, 86, 0])).toEqual([170, 172, 0]);
    expect(toStepsPerMinute([170, 172])).toEqual([170, 172]);
  });

  it('découpe une sortie en tronçons de ~100 m avec pente et cadence', () => {
    const a = readActivity('sortie.fit', writeFit(simulateRun(LAW)));
    expect(a.distanceKm).toBeGreaterThan(9);
    expect(a.segments.length).toBeGreaterThan(80);
    expect(a.date).toMatch(/^2021-/);
    const s = a.segments[10];
    expect(s.cadence).toBeGreaterThan(150);
    expect(s.cadence).toBeLessThan(200);
    expect(Math.max(...a.segments.map((x) => x.gradePct))).toBeGreaterThan(5);
    expect(Math.min(...a.segments.map((x) => x.gradePct))).toBeLessThan(-5);
  });

  it('écarte les arrêts', () => {
    const pts = simulateRun(LAW, { minutes: 10 });
    // Pause de 2 minutes au milieu : même distance, le temps avance.
    const paused = pts.map((p, i) => (i > 300 ? { ...p, t: p.t + 120 } : p));
    const { segments } = segmentActivity(paused.map((p) => ({ t: p.t, dist: p.dist, alt: p.alt, cadence: p.strides * 2 })));
    expect(segments.every((s) => s.speedKmh > 6)).toBe(true);
  });

  it('refuse le vélo et les fichiers sans cadence', () => {
    expect(() => readActivity('velo.fit', writeFit(simulateRun(LAW, { minutes: 5 }), { sport: 2 }))).toThrow(/course à pied/);
    const noCad = simulateRun(LAW, { minutes: 5 }).map((p) => ({ ...p, strides: 0 }));
    expect(() => readActivity('x.fit', writeFit(noCad))).toThrow(/cadence/);
  });

  it('lit un TCX avec RunCadence', () => {
    const tp = (i: number) =>
      `<Trackpoint><Time>2026-05-01T08:00:${String(i).padStart(2, '0')}Z</Time><DistanceMeters>${i * 3}</DistanceMeters><AltitudeMeters>100</AltitudeMeters><Extensions><ns3:TPX><ns3:RunCadence>86</ns3:RunCadence></ns3:TPX></Extensions></Trackpoint>`;
    const tcx = `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap><Track>${Array.from({ length: 30 }, (_, i) => tp(i)).join('')}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const { samples } = samplesFromTcx(tcx);
    expect(samples).toHaveLength(30);
    expect(samples[5]).toMatchObject({ t: 5, dist: 15, cadence: 172 });
  });
});

describe('calibrage', () => {
  it('retrouve la loi de cadence d’une sortie vallonnée', () => {
    const { segments } = readActivity('sortie.fit', writeFit(simulateRun(LAW, { minutes: 90 })));
    const m = calibrate(segments);
    expect(m.uphill).toBeCloseTo(LAW.up, 0);
    expect(Math.abs(m.uphill - LAW.up)).toBeLessThan(0.25);
    expect(Math.abs(m.downhill - LAW.down)).toBeLessThan(0.25);
    expect(Math.abs(m.kv - LAW.kv)).toBeLessThan(1);
    // Prédiction à 11 km/h sur le plat : proche de la vraie loi.
    expect(Math.abs(predictCadence(m, 11) - (LAW.k0 + LAW.kv * 11))).toBeLessThan(1.5);
    expect(m.rmse).toBeLessThan(3);
  });

  it('sur une sortie plate, les coefficients de pente restent proches des valeurs par défaut', () => {
    const { segments } = readActivity('plat.fit', writeFit(simulateRun({ ...LAW, up: 3, down: 3 }, { hilly: false })));
    const m = calibrate(segments);
    expect(Math.abs(m.uphill - DEFAULT_MODEL.uphill)).toBeLessThan(0.3);
    expect(Math.abs(m.downhill - DEFAULT_MODEL.downhill)).toBeLessThan(0.3);
    // …mais la cadence au plat est bien celle du coureur.
    expect(Math.abs(predictCadence(m, 11) - (LAW.k0 + LAW.kv * 11))).toBeLessThan(1.5);
  });

  it('refuse trop peu de données', () => {
    expect(() => calibrate([])).toThrow();
  });
});

describe('effet de la vitesse par section', () => {
  const sec = (start: number, grade: number): Section => ({ startDist: start, endDist: start + 1000, length: 1000, eleStart: 0, eleEnd: grade * 1000, grade });
  it('baisse la cadence quand on ralentit en montée (effort constant)', () => {
    const sections = [sec(0, 0), sec(1000, 0.08)];
    const base = { targetPace: 300, mode: 'effort' as const, baseCadence: 172, uphillSensitivity: 0.6, speedSensitivity: 3 };
    const without = planRun(sections, base);
    const withEffect = planRun(sections, { ...base, sectionSpeedEffect: true });
    expect(withEffect.sections[1].cadence).toBeLessThan(without.sections[1].cadence);
    expect(withEffect.sections[0].cadence).toBe(without.sections[0].cadence);
  });
});
