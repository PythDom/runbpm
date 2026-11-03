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

/**
 * Période locale du battement (en trames) à chaque trame. Par fenêtres de 8 s (tous les 1 s), chaque
 * décalage à ±35 % de la période globale est noté par son peigne (1 à 4 temps), normalisé ; on garde le
 * chemin à travers les fenêtres qui a le meilleur score tout en variant doucement (Viterbi, un coût par
 * changement de tempo), interpolé linéairement entre fenêtres. Avec une période unique pour tout le
 * morceau, le suivi décroche dès que le tempo s'écarte de plus de ~15 % (morceau joué sans clic,
 * refrain plus rapide). Repris de MusicDAWM (BeatDetect::local_period).
 */
export function localPeriod(env: Float64Array, fps: number, period: number): Float64Array {
  const n = env.length;
  const per = new Float64Array(n).fill(period);
  const win = Math.round(8 * fps);
  const hop = Math.max(1, Math.round(fps));
  if (n < 2 * win) return per;
  const lo = period / 1.35;
  const hi = period * 1.35;
  const maxLag = Math.ceil(4 * hi) + 2;
  const lags: number[] = [];
  for (let lag = lo; lag <= hi; lag += 0.25) lags.push(lag);
  const L = lags.length;
  const centres: number[] = [];
  const scores: Float64Array[] = [];
  const ac = new Float64Array(maxLag + 1);
  for (let c = win / 2; c + win / 2 <= n; c += hop) {
    const a = Math.round(c - win / 2);
    for (let lag = 1; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = a; i < a + win && i + lag < n; i++) s += env[i] * env[i + lag];
      ac[lag] = s;
    }
    const row = new Float64Array(L);
    let max = 0;
    for (let j = 0; j < L; j++) {
      let s = 0;
      for (let k = 1; k <= 4; k++) {
        const pos = k * lags[j];
        const i = Math.floor(pos);
        const t = pos - i;
        s += i + 1 <= maxLag ? ac[i] * (1 - t) + ac[i + 1] * t : 0;
      }
      row[j] = s;
      if (s > max) max = s;
    }
    for (let j = 0; j < L; j++) row[j] = max > 0 ? Math.max(0, row[j] / max) : 0;
    centres.push(c);
    scores.push(row);
  }
  // Viterbi : changer de tempo d'un rapport r entre deux fenêtres coûte CHANGE·log(r)² (3 % ≈ 0,04).
  const CHANGE = 50;
  const W = scores.length;
  const logLag = lags.map((l) => Math.log(l));
  let d = Float64Array.from(scores[0]);
  const from: Int32Array[] = [new Int32Array(L)];
  for (let w = 1; w < W; w++) {
    const nd = new Float64Array(L);
    const fr = new Int32Array(L);
    for (let j = 0; j < L; j++) {
      let best = -Infinity;
      let arg = 0;
      for (let i = 0; i < L; i++) {
        const r = logLag[j] - logLag[i];
        const v = d[i] - CHANGE * r * r;
        if (v > best) {
          best = v;
          arg = i;
        }
      }
      nd[j] = best + scores[w][j];
      fr[j] = arg;
    }
    d = nd;
    from.push(fr);
  }
  const path = new Float64Array(W);
  let j = 0;
  for (let i = 1; i < L; i++) if (d[i] > d[j]) j = i;
  for (let w = W - 1; w >= 0; w--) {
    path[w] = lags[j];
    j = from[w][j];
  }
  for (let t = 0; t < n; t++) {
    if (t <= centres[0]) per[t] = path[0];
    else if (t >= centres[W - 1]) per[t] = path[W - 1];
    else {
      const a = Math.floor((t - centres[0]) / hop);
      const b = Math.min(a + 1, W - 1);
      const f = b > a ? (t - centres[a]) / (centres[b] - centres[a]) : 0;
      per[t] = path[a] * (1 - f) + path[b] * f;
    }
  }
  return per;
}

/**
 * Instant d'un temps entre deux trames : sommet de la courbe d'attaques à ±1 trame de la trame suivie,
 * affiné par une parabole passant par ses voisines (précision bien meilleure que la trame de 11,6 ms).
 */
export function subframe(env: Float64Array, f: number): number {
  const n = env.length;
  let m = f;
  for (let k = Math.max(0, f - 1); k <= Math.min(n - 1, f + 1); k++) if (env[k] > env[m]) m = k;
  if (m <= 0 || m >= n - 1) return m;
  const a = env[m - 1];
  const b = env[m];
  const c = env[m + 1];
  const den = a - 2 * b + c;
  if (!(b > 0) || Math.abs(den) < 1e-12) return m;
  return m + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
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
  // Période locale : le suivi accompagne les variations de tempo au fil du morceau.
  const per = localPeriod(env, fps, period);

  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    const p = per[t];
    const minLag = Math.max(1, Math.round(p / 2));
    const maxLag = Math.round(p * 2);
    for (let lag = minLag; lag <= maxLag && t - lag >= 0; lag++) {
      const s = score[t - lag] - TIGHTNESS * Math.log(lag / p) ** 2;
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
  for (let t = Math.max(0, n - Math.round(per[n - 1])); t < n; t++) if (score[t] > score[end]) end = t;
  const frames: number[] = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();

  // Les tout premiers temps peuvent tomber avant la musique (introduction) : on les garde, la grille reste régulière.
  // Trame f → centre de sa fenêtre d'analyse, corrigé du décalage de détection.
  const hopSeconds = 1 / fps;
  const halfWindow = 512 / rate;
  // Chaque temps entre deux trames (sommet de l'attaque, interpolé).
  const beats = frames.map((f) => Math.max(0, subframe(env, f) * hopSeconds + halfWindow + ONSET_OFFSET_SECONDS));
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
