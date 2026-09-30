import { downsample, onsetEnvelope } from './bpm';

/**
 * Suivi des temps (beat tracking) par programmation dynamique (D. Ellis, « Beat Tracking by
 * Dynamic Programming », 2007) : connaissant le tempo, on cherche la suite de temps qui passe par
 * les attaques les plus fortes tout en gardant des intervalles proches de la période.
 *
 * Sert à caler les clics du métronome sur les vrais temps du morceau (et à suivre ses petites
 * variations de tempo), au lieu d'un métronome qui démarre à un instant quelconque et dérive.
 */

export interface BeatGrid {
  /** Instants des temps, en secondes depuis le début du signal analysé. */
  beats: number[];
  /** Tempo moyen mesuré sur les temps suivis (régression), en BPM. */
  bpm: number;
}

/** Contrainte de régularité : plus elle est forte, plus les intervalles restent proches de la période. */
const TIGHTNESS = 100;

/**
 * Correction entre le centre de la fenêtre d'analyse et l'instant réel de l'attaque : mesurée à
 * +25 ms sur des boucles synthétiques (temps connus exactement), cohérent avec les temps annotés
 * par madmom sur de la vraie musique (voir tests).
 */
export const ONSET_OFFSET_SECONDS = 0.025;

export function trackBeats(samples: Float32Array, sampleRate: number, bpm: number): BeatGrid | undefined {
  if (!(bpm > 0)) return undefined;
  const { data, rate } = downsample(samples, sampleRate);
  const { env, fps } = onsetEnvelope(data, rate);
  const n = env.length;
  const period = (60 * fps) / bpm;
  if (n < period * 4) return undefined;

  // Normalisation (écart-type) pour que le poids de la régularité soit comparable d'un morceau à l'autre.
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of env) variance += (v - mean) ** 2;
  const std = Math.sqrt(variance / n) || 1;
  const onset = Float64Array.from(env, (v) => v / std);

  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const minLag = Math.max(1, Math.round(period / 2));
  const maxLag = Math.round(period * 2);
  // Coût de transition pré-calculé par décalage.
  const cost = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) cost[lag] = -TIGHTNESS * Math.log(lag / period) ** 2;

  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let lag = minLag; lag <= maxLag && t - lag >= 0; lag++) {
      const s = score[t - lag] + cost[lag];
      if (s > best) {
        best = s;
        arg = t - lag;
      }
    }
    score[t] = onset[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }

  // Dernier temps : meilleur score dans la dernière période.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const frames: number[] = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();

  // Les tout premiers temps peuvent tomber avant la musique (introduction) : on les garde, la grille reste régulière.
  // Trame f → centre de sa fenêtre d'analyse, corrigé du décalage de détection.
  const hopSeconds = 1 / fps;
  const halfWindow = 512 / rate;
  const beats = frames.map((f) => Math.max(0, f * hopSeconds + halfWindow + ONSET_OFFSET_SECONDS));
  // Tempo moyen par régression linéaire des temps sur leur rang.
  const k = beats.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  beats.forEach((y, x) => {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  });
  const slope = (k * sxy - sx * sy) / (k * sxx - sx * sx);
  return { beats, bpm: slope > 0 ? Math.round((60 / slope) * 100) / 100 : bpm };
}

/**
 * Affine un tempo détecté grâce au suivi des temps : sur une musique régulière, la régression sur
 * les temps suivis est bien plus précise que le pic d'autocorrélation (ex. 144,9 → 144,05 BPM).
 * Renvoie le tempo initial si le suivi s'en écarte trop (musique au tempo fluctuant).
 */
export function refineTempo(samples: Float32Array, sampleRate: number, bpm: number): number {
  const grid = trackBeats(samples, sampleRate, bpm);
  if (!grid || Math.abs(grid.bpm / bpm - 1) > 0.03) return bpm;
  return Math.round(grid.bpm * 10) / 10;
}
