import { describe, expect, it } from 'vitest';
import { refineTempo, trackBeats } from '../src/core/beats';
import { drumLoop } from './helpers/synth';

/** Proportion des temps attendus retrouvés à ±tol secondes, et décalage médian (s). */
function match(est: number[], ref: number[], tol = 0.05) {
  const offs: number[] = [];
  for (const r of ref) {
    const e = est.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), Infinity);
    if (Math.abs(e - r) <= tol) offs.push(e - r);
  }
  offs.sort((a, b) => a - b);
  return { recall: offs.length / ref.length, median: offs[Math.floor(offs.length / 2)] ?? NaN };
}

/** Grosse caisse sur chaque temps, tempo passant linéairement de bpm0 à bpm1. */
function rampLoop(bpm0: number, bpm1: number, seconds: number, rate = 22050) {
  const out = new Float32Array(seconds * rate);
  const beats: number[] = [];
  for (let t = 0; t < seconds - 0.3; ) {
    beats.push(t);
    const i0 = Math.round(t * rate);
    for (let i = 0; i < 0.2 * rate && i0 + i < out.length; i++) {
      const x = i / rate;
      out[i0 + i] += 0.9 * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-x * 30)) * x) * Math.exp(-x * 12);
    }
    t += 60 / (bpm0 + ((bpm1 - bpm0) * t) / seconds);
  }
  return { out, beats };
}

describe('trackBeats', () => {
  for (const bpm of [120, 150, 176]) {
    it(`place les temps d’une boucle à ${bpm} BPM`, () => {
      const g = trackBeats(drumLoop(bpm, 30, 22050), 22050, bpm)!;
      const ref = Array.from({ length: Math.floor((29 * bpm) / 60) }, (_, k) => (k * 60) / bpm).slice(1);
      const m = match(g.beats, ref);
      expect(m.recall).toBeGreaterThan(0.95);
      expect(Math.abs(m.median)).toBeLessThan(0.01); // < 10 ms
      expect(Math.abs(g.bpm - bpm)).toBeLessThan(0.1);
    });
  }

  it('suit un tempo qui accélère (170 → 178 BPM)', () => {
    const { out, beats } = rampLoop(170, 178, 60);
    const g = trackBeats(out, 22050, 174)!;
    const m = match(g.beats, beats.slice(2, -2), 0.03);
    expect(m.recall).toBeGreaterThan(0.95);
  });

  it('suit une forte accélération (120 → 190 BPM)', () => {
    const { out, beats } = rampLoop(120, 190, 60);
    const g = trackBeats(out, 22050, 152)!;
    const m = match(g.beats, beats.slice(2, -2), 0.03);
    expect(m.recall).toBeGreaterThan(0.95);
  });

  it('suit un changement brusque de tempo (140 puis 185 BPM)', () => {
    const a = drumLoop(140, 30, 22050);
    const b = drumLoop(185, 30, 22050, { seed: 3 });
    const out = new Float32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    const ref = [
      ...Array.from({ length: Math.floor((29.5 * 140) / 60) }, (_, k) => (k * 60) / 140),
      ...Array.from({ length: Math.floor((29.5 * 185) / 60) }, (_, k) => 30 + (k * 60) / 185),
    ].slice(2, -2);
    const g = trackBeats(out, 22050, 162)!;
    const m = match(g.beats, ref, 0.03);
    expect(m.recall).toBeGreaterThan(0.95);
  });

  it('place chaque temps entre deux trames (écart quadratique < 4 ms)', () => {
    const bpm = 150;
    const g = trackBeats(drumLoop(bpm, 30, 22050), 22050, bpm)!;
    const ref = Array.from({ length: Math.floor((29 * bpm) / 60) }, (_, k) => (k * 60) / bpm).slice(1);
    let ss = 0;
    let n = 0;
    for (const r of ref) {
      const e = g.beats.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), Infinity);
      if (Math.abs(e - r) <= 0.05) {
        ss += (e - r) ** 2;
        n++;
      }
    }
    expect(Math.sqrt(ss / n)).toBeLessThan(0.004);
  });

  it('refuse un signal trop court ou un tempo absurde', () => {
    expect(trackBeats(new Float32Array(22050), 22050, 170)).toBeUndefined();
    expect(trackBeats(drumLoop(170, 10, 22050), 22050, 0)).toBeUndefined();
  });
});

describe('refineTempo', () => {
  it('affine un tempo approché', () => {
    const sig = drumLoop(172.5, 40, 22050);
    expect(refineTempo(sig, 22050, 171.8)).toBeCloseTo(172.5, 0);
    expect(Math.abs(refineTempo(sig, 22050, 171.8) - 172.5)).toBeLessThanOrEqual(0.1);
  });
  it('garde le tempo initial si le suivi s’en écarte trop', () => {
    const { out } = rampLoop(150, 190, 60);
    const r = refineTempo(out, 22050, 150);
    expect(r === 150 || Math.abs(r / 150 - 1) <= 0.03).toBe(true);
  });
});
