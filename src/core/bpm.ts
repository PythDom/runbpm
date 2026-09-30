/**
 * Détection du tempo (BPM) à partir du signal audio.
 *
 * Méthode classique en trois étapes :
 *  1. Courbe d'attaques (« onset strength ») : flux spectral du signal ramené à ~11 kHz,
 *     c'est-à-dire l'augmentation d'énergie d'une trame à la suivante, bande par bande.
 *  2. Autocorrélation de cette courbe : les attaques se répètent à la période du battement.
 *  3. Pour chaque tempo candidat (0,05 BPM près), on additionne l'autocorrélation aux multiples
 *     de la période (peigne) : le vrai tempo cumule des pics à 1, 2, 3, 4 battements.
 *
 * Une erreur d'octave (88 au lieu de 176) est sans conséquence pour la course : la playlist
 * accepte les morceaux à mi-tempo. Les erreurs de rapport 3/2 sont limitées par le peigne.
 */

export interface TempoResult {
  bpm: number;
  /** Indice de confiance entre 0 (bruit, pas de pulsation) et 1 (pulsation très nette). */
  confidence: number;
}

export interface TempoOptions {
  minBpm: number;
  maxBpm: number;
}

const DEFAULT_OPTIONS: TempoOptions = { minBpm: 70, maxBpm: 200 };

const FRAME = 1024;
const HOP = 128;

/** FFT radix-2 en place (re, im de longueur puissance de 2). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Ramène le signal vers ~11 kHz par moyenne de blocs (suffisant pour les attaques). */
export function downsample(samples: Float32Array, sampleRate: number): { data: Float32Array; rate: number } {
  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  if (factor === 1) return { data: samples, rate: sampleRate };
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) s += samples[base + k];
    out[i] = s / factor;
  }
  return { data: out, rate: sampleRate / factor };
}

/** Courbe d'attaques : flux spectral (log-magnitude), moyenne locale retirée, rectifiée. */
export function onsetEnvelope(samples: Float32Array, rate: number): { env: Float64Array; fps: number } {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const env = new Float64Array(frames);
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const maxBin = Math.min(FRAME / 2, Math.round((5000 / rate) * FRAME));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(maxBin);
  let cur = new Float64Array(maxBin);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < maxBin; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (f > 0) {
        const d = cur[k] - prev[k];
        if (d > 0) flux += d;
      }
    }
    env[f] = flux;
    [prev, cur] = [cur, prev];
  }
  const fps = rate / HOP;
  // Retire la tendance lente (moyenne sur ~0,5 s) pour ne garder que les attaques.
  const half = Math.round(fps * 0.25);
  const prefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i] + env[i];
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(frames, i + half + 1);
    const v = env[i] - (prefix[hi] - prefix[lo]) / (hi - lo);
    out[i] = v > 0 ? v : 0;
  }
  return { env: out, fps };
}

function autocorrelation(x: Float64Array, maxLag: number): Float64Array {
  const n = x.length;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (n - lag);
  }
  return ac;
}

function interp(ac: Float64Array, pos: number): number {
  const i = Math.floor(pos);
  if (i + 1 >= ac.length) return 0;
  const t = pos - i;
  return ac[i] * (1 - t) + ac[i + 1] * t;
}

/** Détecte le tempo d'un signal mono. Renvoie undefined si le signal est trop court ou muet. */
export function detectTempo(samples: Float32Array, sampleRate: number, options: Partial<TempoOptions> = {}): TempoResult | undefined {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { data, rate } = downsample(samples, sampleRate);
  if (data.length < rate * 8) return undefined; // au moins 8 secondes
  const { env, fps } = onsetEnvelope(data, rate);
  const energy = env.reduce((a, v) => a + v, 0);
  if (energy <= 1e-9) return undefined;

  const COMB = 4;
  const maxLag = Math.ceil(((60 * fps) / opts.minBpm) * COMB) + 2;
  const ac = autocorrelation(env, Math.min(maxLag, env.length - 1));

  const scores: { bpm: number; score: number }[] = [];
  for (let bpm = opts.minBpm; bpm <= opts.maxBpm + 1e-9; bpm += 0.05) {
    const lag = (60 * fps) / bpm;
    let s = 0;
    for (let k = 1; k <= COMB; k++) s += interp(ac, k * lag);
    scores.push({ bpm, score: s / COMB });
  }
  let best = scores[0];
  for (const c of scores) if (c.score > best.score) best = c;
  if (best.score <= 0) return undefined;

  // Choix de l'octave : la période de 2 temps (caisse claire un temps sur deux) est souvent plus
  // régulière que celle d'un temps, et un charleston en croches fait ressortir le double tempo.
  // Parmi le tempo, son double et sa moitié qui présentent une vraie pulsation, on retient le plus
  // proche de 140 BPM : pour la course, 176 plutôt que 88 (les deux restent utilisables).
  const at = (bpm: number) => {
    const idx = Math.round((bpm - opts.minBpm) / 0.05);
    let m = 0;
    for (let d = -20; d <= 20; d++) m = Math.max(m, scores[idx + d]?.score ?? 0);
    return m;
  };
  const distance = (bpm: number) => Math.abs(Math.log2(bpm / 140));
  let bpm = best.bpm;
  for (const candidate of [best.bpm * 2, best.bpm / 2]) {
    if (candidate < opts.minBpm || candidate > opts.maxBpm) continue;
    if (at(candidate) >= 0.35 * best.score && distance(candidate) < distance(bpm)) bpm = candidate;
  }

  // Affinage : maximum local autour du tempo retenu, avec un peigne long (jusqu'à 16 battements)
  // qui accumule l'écart de période et donne une précision bien inférieure à la trame.
  const beatLag = (60 * fps) / bpm;
  const longComb = Math.max(COMB, Math.min(16, Math.floor(env.length / 2 / beatLag)));
  const acLong = autocorrelation(env, Math.min(Math.ceil(beatLag * 1.02 * longComb) + 2, env.length - 1));
  let refined = bpm;
  let refinedScore = -Infinity;
  for (let b = bpm - 1; b <= bpm + 1; b += 0.01) {
    const lag = (60 * fps) / b;
    let s = 0;
    for (let k = 1; k <= longComb; k++) s += interp(acLong, k * lag);
    if (s > refinedScore) {
      refinedScore = s;
      refined = b;
    }
  }

  // Confiance : autocorrélation normalisée de la courbe d'attaques centrée, au meilleur décalage
  // entre 0,3 et 1,5 s (≈ 0,05 pour du bruit, > 0,8 pour une pulsation nette).
  const mean = env.reduce((a, v) => a + v, 0) / env.length;
  const centered = env.map((v) => v - mean);
  const acc = autocorrelation(centered, Math.min(Math.ceil(1.5 * fps), centered.length - 1));
  let periodicity = 0;
  for (let lag = Math.round(0.3 * fps); lag < acc.length; lag++) periodicity = Math.max(periodicity, acc[lag] / Math.max(acc[0], 1e-12));
  const confidence = Math.max(0, Math.min(1, (periodicity - 0.1) / 0.6));
  return { bpm: Math.round(refined * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}

/** Moyenne des canaux (stéréo → mono). */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}
