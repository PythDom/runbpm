import type { CadenceSegment } from './activity';

/**
 * Modèle personnel de cadence, ajusté sur des sorties enregistrées :
 *
 *   cadence = k0 + kv × vitesse(km/h) + montée × pente⁺(%) + descente × pente⁻(%)
 *
 * Moindres carrés pondérés par la durée des tronçons, avec un rappel doux vers les valeurs par
 * défaut de RunBPM (régression « ridge ») : sur une sortie plate, les coefficients de pente ne
 * peuvent pas être estimés et restent proches des valeurs par défaut ; plus les données couvrent
 * de pentes et de vitesses variées, plus elles l'emportent.
 */

export interface CadenceModel {
  k0: number;
  /** Pas/min par km/h. */
  kv: number;
  /** Pas/min par % de montée. */
  uphill: number;
  /** Pas/min par % de descente. */
  downhill: number;
}

export interface CalibrationResult extends CadenceModel {
  segments: number;
  /** Durée totale exploitée (s). */
  seconds: number;
  /** Écart-type des résidus (pas/min). */
  rmse: number;
  speedRange: [number, number];
  gradeRange: [number, number];
}

export const DEFAULT_MODEL: CadenceModel = { k0: 140, kv: 3, uphill: 0.6, downhill: 0.3 };

/** Force du rappel vers les valeurs par défaut (équivalent en « variance » de la variable). */
const PRIOR_STRENGTH = { kv: 0.5, uphill: 1, downhill: 1 };

export function predictCadence(m: CadenceModel, speedKmh: number, gradePct = 0): number {
  return m.k0 + m.kv * speedKmh + (gradePct > 0 ? m.uphill * gradePct : -m.downhill * gradePct);
}

/** Résout le système linéaire A·x = b (élimination de Gauss avec pivot partiel). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) throw new Error('Données insuffisantes pour le calibrage.');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function calibrate(segments: CadenceSegment[], prior: CadenceModel = DEFAULT_MODEL): CalibrationResult {
  if (segments.length < 5) throw new Error('Données insuffisantes pour le calibrage.');
  const W = segments.reduce((a, s) => a + s.weight, 0);
  const x = (s: CadenceSegment) => [1, s.speedKmh, Math.max(0, s.gradePct), Math.max(0, -s.gradePct)];
  const ata = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const atb = [0, 0, 0, 0];
  for (const s of segments) {
    const f = x(s);
    for (let i = 0; i < 4; i++) {
      atb[i] += s.weight * f[i] * s.cadence;
      for (let j = 0; j < 4; j++) ata[i][j] += s.weight * f[i] * f[j];
    }
  }
  // Rappel vers les valeurs par défaut (pas sur l'ordonnée à l'origine).
  const lambda = [0, PRIOR_STRENGTH.kv * W, PRIOR_STRENGTH.uphill * W, PRIOR_STRENGTH.downhill * W];
  const priorVec = [0, prior.kv, prior.uphill, prior.downhill];
  for (let i = 1; i < 4; i++) {
    ata[i][i] += lambda[i];
    atb[i] += lambda[i] * priorVec[i];
  }
  const [k0raw, kvRaw, upRaw, downRaw] = solve(ata, atb);
  const kv = clamp(kvRaw, 0, 8);
  const uphill = clamp(upRaw, -1, 3);
  const downhill = clamp(downRaw, -1, 3);
  // Si un coefficient a été borné, on recale l'ordonnée à l'origine sur la moyenne pondérée.
  const mean = (f: (s: CadenceSegment) => number) => segments.reduce((a, s) => a + s.weight * f(s), 0) / W;
  const k0 =
    kv === kvRaw && uphill === upRaw && downhill === downRaw
      ? k0raw
      : mean((s) => s.cadence) - kv * mean((s) => s.speedKmh) - uphill * mean((s) => Math.max(0, s.gradePct)) - downhill * mean((s) => Math.max(0, -s.gradePct));
  const model = { k0, kv, uphill, downhill };
  const rmse = Math.sqrt(mean((s) => (s.cadence - predictCadence(model, s.speedKmh, s.gradePct)) ** 2));
  const speeds = segments.map((s) => s.speedKmh).sort((a, b) => a - b);
  const grades = segments.map((s) => s.gradePct).sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return {
    ...model,
    segments: segments.length,
    seconds: W,
    rmse,
    speedRange: [pct(speeds, 0.05), pct(speeds, 0.95)],
    gradeRange: [pct(grades, 0.05), pct(grades, 0.95)],
  };
}
