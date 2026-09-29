import type { Route } from './route';

/** Portion du parcours de pente à peu près constante. */
export interface Section {
  startDist: number;
  endDist: number;
  length: number;
  eleStart: number;
  eleEnd: number;
  /** Pente moyenne (fraction : 0.05 = +5 %). */
  grade: number;
}

export interface ProfileSample {
  dist: number;
  ele: number;
}

export interface SectionOptions {
  /** Pas de rééchantillonnage, en mètres. */
  step: number;
  /** Fenêtre de lissage de l'altitude (bruit GPS), en mètres. */
  smoothWindow: number;
  /** Largeur des classes de pente, en % (ex. 2 → classes de 2 %). */
  gradeBucket: number;
  /** Longueur minimale d'une section, en mètres. */
  minLength: number;
}

export const DEFAULT_SECTION_OPTIONS: SectionOptions = {
  step: 20,
  smoothWindow: 120,
  gradeBucket: 2,
  minLength: 250,
};

/** Rééchantillonne l'altitude à pas régulier (interpolation linéaire). */
export function resample(route: Route, step: number): ProfileSample[] {
  const pts = route.points;
  const out: ProfileSample[] = [];
  let j = 0;
  const total = route.totalDistance;
  const n = Math.max(1, Math.round(total / step));
  for (let k = 0; k <= n; k++) {
    const d = (k / n) * total;
    while (j < pts.length - 2 && pts[j + 1].dist < d) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const t = b.dist > a.dist ? Math.min(1, Math.max(0, (d - a.dist) / (b.dist - a.dist))) : 0;
    out.push({ dist: d, ele: a.ele + t * (b.ele - a.ele) });
  }
  return out;
}

/** Moyenne glissante centrée sur une fenêtre exprimée en nombre d'échantillons. */
export function smooth(values: number[], halfWindow: number): number[] {
  if (halfWindow <= 0) return [...values];
  const prefix = [0];
  for (const v of values) prefix.push(prefix[prefix.length - 1] + v);
  return values.map((_, i) => {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(values.length - 1, i + halfWindow);
    return (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  });
}

/** Profil lissé, utile aussi pour l'affichage. */
export function smoothedProfile(route: Route, opts: SectionOptions = DEFAULT_SECTION_OPTIONS): ProfileSample[] {
  const samples = resample(route, opts.step);
  const actualStep = samples.length > 1 ? samples[1].dist - samples[0].dist : opts.step;
  const half = Math.round(opts.smoothWindow / 2 / Math.max(1, actualStep));
  const eles = smooth(
    samples.map((s) => s.ele),
    half,
  );
  return samples.map((s, i) => ({ dist: s.dist, ele: eles[i] }));
}

function makeSection(profile: ProfileSample[], i0: number, i1: number): Section {
  const a = profile[i0];
  const b = profile[i1];
  const length = b.dist - a.dist;
  return {
    startDist: a.dist,
    endDist: b.dist,
    length,
    eleStart: a.ele,
    eleEnd: b.ele,
    grade: length > 0 ? (b.ele - a.ele) / length : 0,
  };
}

/**
 * Découpe le parcours en sections de pente homogène :
 *  1. profil rééchantillonné et lissé,
 *  2. chaque pas est rangé dans une classe de pente,
 *  3. les pas consécutifs de même classe sont regroupés,
 *  4. les sections trop courtes sont fusionnées avec la voisine de pente la plus proche,
 *  5. les voisines de pente quasi identique sont réunies.
 */
export function splitSections(route: Route, options: Partial<SectionOptions> = {}): Section[] {
  const opts = { ...DEFAULT_SECTION_OPTIONS, ...options };
  const profile = smoothedProfile(route, opts);
  if (profile.length < 2) return [makeSection(profile, 0, profile.length - 1)];

  const bucketOf = (i: number) => {
    const g = ((profile[i + 1].ele - profile[i].ele) / (profile[i + 1].dist - profile[i].dist)) * 100;
    return Math.round(g / opts.gradeBucket);
  };

  // Frontières exprimées en indices du profil.
  let bounds: number[] = [0];
  let current = bucketOf(0);
  for (let i = 1; i < profile.length - 1; i++) {
    const b = bucketOf(i);
    if (b !== current) {
      bounds.push(i);
      current = b;
    }
  }
  bounds.push(profile.length - 1);

  // Fusion itérative de la section la plus courte tant qu'elle est sous le minimum.
  const minLength = Math.min(opts.minLength, profile[profile.length - 1].dist);
  for (;;) {
    if (bounds.length <= 2) break;
    const secs = bounds.slice(0, -1).map((b, k) => makeSection(profile, b, bounds[k + 1]));
    let shortest = -1;
    for (let k = 0; k < secs.length; k++) {
      if (secs[k].length < minLength && (shortest < 0 || secs[k].length < secs[shortest].length)) shortest = k;
    }
    if (shortest < 0) break;
    const prev = secs[shortest - 1];
    const next = secs[shortest + 1];
    const s = secs[shortest];
    let mergeWithPrev: boolean;
    if (!prev) mergeWithPrev = false;
    else if (!next) mergeWithPrev = true;
    else mergeWithPrev = Math.abs(prev.grade - s.grade) <= Math.abs(next.grade - s.grade);
    // Retirer la frontière entre la section et la voisine choisie.
    const boundaryIndex = mergeWithPrev ? shortest : shortest + 1;
    bounds = bounds.filter((_, idx) => idx !== boundaryIndex);
  }

  // Fusion des voisines de pente quasi identique (ex. 4,8 % et 5,2 % tombent dans deux classes).
  const similar = (opts.gradeBucket / 100) * 0.75;
  for (let merged = true; merged && bounds.length > 2; ) {
    merged = false;
    const secs = bounds.slice(0, -1).map((b, k) => makeSection(profile, b, bounds[k + 1]));
    let bestK = -1;
    for (let k = 0; k < secs.length - 1; k++) {
      const diff = Math.abs(secs[k].grade - secs[k + 1].grade);
      if (diff < similar && (bestK < 0 || diff < Math.abs(secs[bestK].grade - secs[bestK + 1].grade))) bestK = k;
    }
    if (bestK >= 0) {
      bounds = bounds.filter((_, idx) => idx !== bestK + 1);
      merged = true;
    }
  }

  return bounds.slice(0, -1).map((b, k) => makeSection(profile, b, bounds[k + 1]));
}

export function elevationStats(sections: Section[]): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  for (const s of sections) {
    const d = s.eleEnd - s.eleStart;
    if (d > 0) gain += d;
    else loss -= d;
  }
  return { gain, loss };
}
