import { FIT_SPORT_RUNNING, parseFit } from './fit';
import { haversine } from './route';

/**
 * Sortie enregistrée (montre) ramenée à des tronçons de ~100 m : vitesse, pente et cadence
 * mesurées. C'est la matière première du calibrage.
 */

export interface ActivitySample {
  /** Secondes depuis le début de la sortie. */
  t: number;
  dist?: number;
  lat?: number;
  lon?: number;
  alt?: number;
  /** Cadence en pas par minute (deux pieds). */
  cadence?: number;
}

export interface CadenceSegment {
  speedKmh: number;
  /** Pente en %. */
  gradePct: number;
  /** Cadence moyenne en pas/min. */
  cadence: number;
  /** Durée du tronçon (s), sert de poids. */
  weight: number;
}

export interface ActivitySummary {
  name: string;
  /** Date ISO de la sortie, si connue. */
  date?: string;
  distanceKm: number;
  segments: CadenceSegment[];
  warnings: string[];
}

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

/**
 * Les montres enregistrent souvent la cadence d'un seul pied (foulées/min, ~80–95) ;
 * on la double si c'est le cas pour obtenir des pas/min.
 */
export function toStepsPerMinute(values: number[]): number[] {
  const valid = values.filter((v) => v > 0).sort((a, b) => a - b);
  const median = valid.length ? valid[Math.floor(valid.length / 2)] : 0;
  return median > 0 && median < 120 ? values.map((v) => v * 2) : values;
}

export function samplesFromFit(bytes: Uint8Array): { samples: ActivitySample[]; date?: string; warnings: string[] } {
  const fit = parseFit(bytes);
  const warnings: string[] = [];
  if (fit.crcMismatch) warnings.push('Somme de contrôle FIT incorrecte : fichier peut-être incomplet.');
  if (fit.sport !== undefined && fit.sport !== FIT_SPORT_RUNNING) {
    throw new Error('Cette activité n’est pas une course à pied (la cadence n’aurait pas le même sens).');
  }
  const recs = fit.records.filter((r) => r.timestamp !== undefined);
  if (recs.length === 0) throw new Error('Aucun point enregistré dans ce fichier.');
  const t0 = recs[0].timestamp!;
  const cad = toStepsPerMinute(recs.map((r) => r.cadence ?? 0));
  return {
    samples: recs.map((r, i) => ({ t: r.timestamp! - t0, dist: r.distance, lat: r.lat, lon: r.lon, alt: r.altitude, cadence: cad[i] || undefined })),
    date: new Date(FIT_EPOCH_MS + t0 * 1000).toISOString(),
    warnings,
  };
}

function tag(body: string, name: string): string | undefined {
  return new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(body)?.[1];
}

export function samplesFromTcx(text: string): { samples: ActivitySample[]; date?: string; warnings: string[] } {
  const sport = /<(?:\w+:)?Activity\b[^>]*Sport="([^"]+)"/.exec(text)?.[1];
  if (sport && !/running/i.test(sport)) throw new Error('Cette activité n’est pas une course à pied.');
  const raw: { time: number; dist?: number; lat?: number; lon?: number; alt?: number; cad?: number }[] = [];
  const re = /<(?:\w+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Trackpoint>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const time = Date.parse(tag(body, 'Time') ?? '');
    if (!Number.isFinite(time)) continue;
    const num = (name: string) => {
      const v = Number.parseFloat(tag(body, name) ?? '');
      return Number.isFinite(v) ? v : undefined;
    };
    raw.push({ time, dist: num('DistanceMeters'), lat: num('LatitudeDegrees'), lon: num('LongitudeDegrees'), alt: num('AltitudeMeters'), cad: num('RunCadence') ?? num('Cadence') });
  }
  if (raw.length === 0) throw new Error('Aucun point horodaté dans ce fichier TCX.');
  const cad = toStepsPerMinute(raw.map((r) => r.cad ?? 0));
  return {
    samples: raw.map((r, i) => ({ t: (r.time - raw[0].time) / 1000, dist: r.dist, lat: r.lat, lon: r.lon, alt: r.alt, cadence: cad[i] || undefined })),
    date: new Date(raw[0].time).toISOString(),
    warnings: [],
  };
}

/**
 * Découpe une sortie en tronçons d'environ `segmentMeters` mètres. On écarte les arrêts, la marche,
 * les cadences aberrantes et les pentes extrêmes (altitude GPS peu fiable).
 */
export function segmentActivity(samples: ActivitySample[], segmentMeters = 100): { segments: CadenceSegment[]; distance: number } {
  // Distance cumulée : champ du fichier, sinon positions GPS.
  const pts = samples.filter((s) => s.t !== undefined);
  const dist: number[] = [];
  let cum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.dist !== undefined) cum = p.dist;
    else if (i > 0 && p.lat !== undefined && p.lon !== undefined && pts[i - 1].lat !== undefined && pts[i - 1].lon !== undefined) {
      cum += haversine(pts[i - 1].lat!, pts[i - 1].lon!, p.lat, p.lon);
    }
    dist.push(cum);
  }
  const total = dist.length ? dist[dist.length - 1] : 0;

  // Altitude lissée (±30 m) aux bornes de tronçon, pour limiter le bruit du GPS/baromètre.
  const altAt = (d: number): number | undefined => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].alt !== undefined && Math.abs(dist[i] - d) <= 30) {
        s += pts[i].alt!;
        n++;
      }
    }
    return n ? s / n : undefined;
  };

  const segments: CadenceSegment[] = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (dist[i] - dist[start] < segmentMeters && i < pts.length - 1) continue;
    const dd = dist[i] - dist[start];
    const dt = pts[i].t - pts[start].t;
    const from = start;
    start = i;
    if (dd < segmentMeters * 0.5 || dt <= 0) continue;
    const speedKmh = (dd / dt) * 3.6;
    // Pause ou marche : non représentatif de la foulée de course.
    if (speedKmh < 6 || speedKmh > 30) continue;
    let cadSum = 0;
    let cadTime = 0;
    for (let k = from + 1; k <= i; k++) {
      const c = pts[k].cadence;
      const w = pts[k].t - pts[k - 1].t;
      if (c !== undefined && c >= 120 && c <= 240 && w > 0 && w <= 10) {
        cadSum += c * w;
        cadTime += w;
      }
    }
    if (cadTime < dt * 0.6) continue;
    const a0 = altAt(dist[from]);
    const a1 = altAt(dist[i]);
    const gradePct = a0 !== undefined && a1 !== undefined ? ((a1 - a0) / dd) * 100 : 0;
    if (Math.abs(gradePct) > 25) continue;
    segments.push({ speedKmh, gradePct, cadence: cadSum / cadTime, weight: dt });
  }
  return { segments, distance: total };
}

export function readActivity(fileName: string, bytes: Uint8Array): ActivitySummary {
  const isFit = /\.fit$/i.test(fileName) || String.fromCharCode(...bytes.subarray(8, 12)) === '.FIT';
  const parsed = isFit ? samplesFromFit(bytes) : samplesFromTcx(new TextDecoder().decode(bytes));
  if (!parsed.samples.some((s) => s.cadence)) throw new Error('Pas de cadence dans ce fichier (capteur ou montre sans mesure de cadence ?).');
  const { segments, distance } = segmentActivity(parsed.samples);
  if (segments.length < 5) throw new Error('Trop peu de portions courues exploitables (sortie trop courte ou données incomplètes).');
  return { name: fileName, date: parsed.date, distanceKm: distance / 1000, segments, warnings: parsed.warnings };
}
