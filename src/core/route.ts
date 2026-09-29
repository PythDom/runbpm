/**
 * Lecture des parcours.
 *
 * Formats acceptés :
 *  - GPX (points de trace <trkpt> ou de route <rtept>, altitude dans <ele>)
 *  - TCX (Garmin : <Trackpoint> avec <AltitudeMeters>, <DistanceMeters> optionnel)
 *  - JSON « RunBPM », deux variantes :
 *      { "name": "...", "points": [{ "lat": 45.1, "lon": 5.7, "ele": 212 }, ...] }
 *      { "name": "...", "profile": [{ "distance": 0, "ele": 212 }, ...] }   // distance en mètres
 *    (dans "profile", chaque entrée peut aussi être un couple [distance, altitude])
 */

export interface RoutePoint {
  /** Distance cumulée depuis le départ, en mètres. */
  dist: number;
  /** Altitude en mètres. */
  ele: number;
  lat?: number;
  lon?: number;
}

export interface Route {
  name: string;
  points: RoutePoint[];
  totalDistance: number;
  warnings: string[];
}

interface RawPoint {
  lat?: number;
  lon?: number;
  ele?: number;
  dist?: number;
}

const EARTH_RADIUS_M = 6_371_000;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function num(value: string | undefined | null): number | undefined {
  if (value == null) return undefined;
  const n = Number.parseFloat(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs);
  return m?.[1];
}

function tag(body: string, name: string): string | undefined {
  // Tolère un éventuel préfixe d'espace de noms (ex. <ns3:AltitudeMeters>).
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(body);
  return m?.[1];
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export function parseGpx(text: string): Route {
  // Les points de trace priment : certains GPX contiennent à la fois une route et une trace.
  const tagName = /<trkpt\b/.test(text) ? 'trkpt' : 'rtept';
  const points: RawPoint[] = [];
  const re = new RegExp(`<${tagName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tagName}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lat = num(attr(m[1] ?? '', 'lat'));
    const lon = num(attr(m[1] ?? '', 'lon'));
    if (lat === undefined || lon === undefined) continue;
    points.push({ lat, lon, ele: num(tag(m[2] ?? '', 'ele')) });
  }
  const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(text);
  return buildRoute(nameMatch ? decodeXml(nameMatch[1]) : 'Parcours GPX', points);
}

export function parseTcx(text: string): Route {
  const points: RawPoint[] = [];
  const re = /<(?:\w+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Trackpoint>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const p: RawPoint = {
      lat: num(tag(body, 'LatitudeDegrees')),
      lon: num(tag(body, 'LongitudeDegrees')),
      ele: num(tag(body, 'AltitudeMeters')),
      dist: num(tag(body, 'DistanceMeters')),
    };
    if (p.dist === undefined && (p.lat === undefined || p.lon === undefined)) continue;
    points.push(p);
  }
  const nameMatch = /<(?:\w+:)?(?:Name|Id)>([\s\S]*?)<\/(?:\w+:)?(?:Name|Id)>/.exec(text);
  return buildRoute(nameMatch ? decodeXml(nameMatch[1]) : 'Parcours TCX', points);
}

export function parseJsonRoute(text: string): Route {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Fichier JSON invalide.');
  }
  if (typeof data !== 'object' || data === null) throw new Error('JSON de parcours invalide.');
  const obj = data as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : 'Parcours JSON';
  const pick = (o: Record<string, unknown>, ...keys: string[]) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = num(v);
        if (n !== undefined) return n;
      }
    }
    return undefined;
  };

  if (Array.isArray(obj.points)) {
    const points = (obj.points as unknown[]).flatMap((p): RawPoint[] => {
      if (typeof p !== 'object' || p === null) return [];
      const o = p as Record<string, unknown>;
      const lat = pick(o, 'lat', 'latitude');
      const lon = pick(o, 'lon', 'lng', 'longitude');
      if (lat === undefined || lon === undefined) return [];
      return [{ lat, lon, ele: pick(o, 'ele', 'elevation', 'alt', 'altitude') }];
    });
    return buildRoute(name, points);
  }
  if (Array.isArray(obj.profile)) {
    const points = (obj.profile as unknown[]).flatMap((p): RawPoint[] => {
      if (Array.isArray(p) && p.length >= 2) return [{ dist: Number(p[0]), ele: Number(p[1]) }];
      if (typeof p !== 'object' || p === null) return [];
      const o = p as Record<string, unknown>;
      const dist = pick(o, 'distance', 'dist', 'd');
      if (dist === undefined) return [];
      return [{ dist, ele: pick(o, 'ele', 'elevation', 'alt', 'altitude') }];
    });
    return buildRoute(name, points);
  }
  throw new Error('Le JSON doit contenir un tableau "points" (lat/lon/ele) ou "profile" (distance/ele).');
}

/** Détecte le format à partir de l'extension, puis du contenu. */
export function parseRouteFile(fileName: string, text: string): Route {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'gpx') return parseGpx(text);
  if (ext === 'tcx') return parseTcx(text);
  if (ext === 'json') return parseJsonRoute(text);
  const head = text.trimStart();
  if (head.startsWith('{')) return parseJsonRoute(text);
  if (/<gpx\b/.test(head)) return parseGpx(text);
  if (/TrainingCenterDatabase/.test(head)) return parseTcx(text);
  throw new Error(`Format de parcours non reconnu : ${fileName}`);
}

/**
 * Construit un parcours à distances cumulées à partir de points bruts.
 * Si les points ont une distance explicite, elle est utilisée ; sinon on la calcule
 * par la formule de haversine. Les altitudes manquantes sont interpolées.
 */
export function buildRoute(name: string, raw: RawPoint[]): Route {
  const warnings: string[] = [];
  if (raw.length < 2) throw new Error('Le parcours doit contenir au moins 2 points.');

  const useExplicitDist = raw.every((p) => p.dist !== undefined && Number.isFinite(p.dist));
  const dists: number[] = [];
  let cum = 0;
  for (let i = 0; i < raw.length; i++) {
    if (useExplicitDist) {
      cum = raw[i].dist as number;
    } else if (i > 0) {
      const a = raw[i - 1];
      const b = raw[i];
      if (a.lat === undefined || a.lon === undefined || b.lat === undefined || b.lon === undefined) {
        throw new Error('Coordonnées manquantes : impossible de calculer les distances.');
      }
      cum += haversine(a.lat, a.lon, b.lat, b.lon);
    }
    dists.push(cum);
  }

  // Altitudes : interpolation linéaire des trous, extrapolation constante aux bords.
  const known = raw.map((p, i) => ({ i, ele: p.ele })).filter((p) => p.ele !== undefined && Number.isFinite(p.ele));
  if (known.length === 0) {
    warnings.push("Aucune altitude dans le fichier : le parcours est considéré comme plat.");
  } else if (known.length < raw.length) {
    warnings.push(`${raw.length - known.length} point(s) sans altitude ont été interpolés.`);
  }
  const eles = raw.map((p) => p.ele);
  if (known.length > 0) {
    for (let i = 0; i < raw.length; i++) {
      if (eles[i] !== undefined && Number.isFinite(eles[i])) continue;
      const prev = [...known].reverse().find((k) => k.i < i);
      const next = known.find((k) => k.i > i);
      if (prev && next) {
        const t = (dists[i] - dists[prev.i]) / Math.max(1e-9, dists[next.i] - dists[prev.i]);
        eles[i] = (prev.ele as number) + t * ((next.ele as number) - (prev.ele as number));
      } else {
        eles[i] = (prev ?? next)!.ele;
      }
    }
  }

  const points: RoutePoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p: RoutePoint = { dist: dists[i], ele: eles[i] ?? 0, lat: raw[i].lat, lon: raw[i].lon };
    // Supprime les doublons (distance non croissante).
    if (points.length > 0 && p.dist <= points[points.length - 1].dist) continue;
    points.push(p);
  }
  if (points.length < 2) throw new Error('Le parcours a une distance nulle.');

  return { name, points, totalDistance: points[points.length - 1].dist, warnings };
}
