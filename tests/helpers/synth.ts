/** Générateur pseudo-aléatoire uniforme sur [-1, 1] (mulberry32 : sans perte de précision). */
function noiseSource(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Génère une boucle rythmique de test (mono) à un tempo donné. */
export function drumLoop(bpm: number, seconds: number, sampleRate = 44100, opts: { hats?: boolean; swingNoise?: number; seed?: number } = {}): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rand = noiseSource(opts.seed ?? 1);
  const beat = 60 / bpm;
  const add = (t0: number, dur: number, fn: (t: number) => number) => {
    const i0 = Math.round(t0 * sampleRate);
    const len = Math.round(dur * sampleRate);
    for (let i = 0; i < len && i0 + i < n; i++) out[i0 + i] += fn(i / sampleRate);
  };
  for (let b = 0, t = 0; t < seconds; b++, t = b * beat) {
    add(t, 0.25, (x) => 0.9 * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-x * 30)) * x) * Math.exp(-x * 12)); // grosse caisse
    if (b % 2 === 1) add(t, 0.15, () => 0.5 * rand()); // caisse claire (bruit)
    if (opts.hats !== false) {
      add(t + beat / 2, 0.04, (x) => 0.25 * rand() * Math.exp(-x * 80)); // charleston sur les croches
    }
  }
  // Nappe d'accords tenus (sans attaque rythmique) et bruit de fond.
  for (let i = 0; i < n; i++) {
    const x = i / sampleRate;
    out[i] += 0.15 * (Math.sin(2 * Math.PI * 220 * x) + Math.sin(2 * Math.PI * 277.2 * x) + Math.sin(2 * Math.PI * 329.6 * x)) / 3;
    out[i] += (opts.swingNoise ?? 0.02) * rand();
  }
  return out;
}

export function whiteNoise(seconds: number, sampleRate = 44100): Float32Array {
  const rand = noiseSource(7);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = rand();
  return out;
}
