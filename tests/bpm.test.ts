import { describe, expect, it } from 'vitest';
import { detectTempo, fft, mixToMono } from '../src/core/bpm';
import { drumLoop, whiteNoise } from './helpers/synth';

/** Égal au tempo attendu, à l'octave près (±1 BPM). */
const octaveClose = (got: number, want: number) => [want, want * 2, want / 2].some((w) => Math.abs(got - w) <= 1);

describe('fft', () => {
  it('retrouve une sinusoïde pure dans la bonne case', () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    expect(re[5]).toBeCloseTo(n / 2, 6);
    expect(Math.abs(re[6])).toBeLessThan(1e-9);
  });
});

describe('detectTempo', () => {
  for (const bpm of [85, 100, 128, 150, 165, 172, 180]) {
    it(`détecte ${bpm} BPM`, () => {
      const r = detectTempo(drumLoop(bpm, 30), 44100);
      expect(r).toBeDefined();
      expect(octaveClose(r!.bpm, bpm), `obtenu ${r!.bpm}`).toBe(true);
      expect(r!.confidence).toBeGreaterThan(0.3);
    });
  }

  it('donne le tempo exact (pas l’octave) sur les tempos de course', () => {
    for (const bpm of [150, 160, 170, 172.5, 176, 185]) {
      const r = detectTempo(drumLoop(bpm, 30, 48000), 48000)!;
      expect(Math.abs(r.bpm - bpm), `${bpm} → ${r.bpm}`).toBeLessThanOrEqual(0.3);
    }
  });

  it('ramène un morceau lent vers la zone de course (88 → 176)', () => {
    const r = detectTempo(drumLoop(88, 30), 44100)!;
    expect(Math.abs(r.bpm - 176)).toBeLessThanOrEqual(0.3);
  });

  it('résiste à un bruit de fond marqué', () => {
    const r = detectTempo(drumLoop(174, 30, 44100, { swingNoise: 0.3, seed: 3 }), 44100)!;
    expect(Math.abs(r.bpm - 174)).toBeLessThanOrEqual(0.3);
  });

  it('confiance faible sur du bruit, rien sur du silence ou un extrait trop court', () => {
    const noise = detectTempo(whiteNoise(20), 44100);
    expect(noise === undefined || noise.confidence < 0.1).toBe(true);
    expect(detectTempo(new Float32Array(44100 * 20), 44100)).toBeUndefined();
    expect(detectTempo(drumLoop(170, 5), 44100)).toBeUndefined();
  });

  it('mélange les canaux', () => {
    expect(Array.from(mixToMono([Float32Array.of(1, 0), Float32Array.of(0, 1)]))).toEqual([0.5, 0.5]);
  });
});
