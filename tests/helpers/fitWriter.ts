import { fitCrc } from '../../src/core/fit';

/** Écrit un fichier FIT minimal (en-tête 14 octets, messages, CRC) pour les tests. */
export interface FitPoint {
  t: number;
  dist: number;
  alt: number;
  speed: number;
  /** Cadence en foulées/min (un pied), comme les montres Garmin. */
  strides: number;
}

export function writeFit(points: FitPoint[], opts: { sport?: number; bigEndianRecords?: boolean; compressEvery?: number; corruptCrc?: boolean } = {}): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number, be = false) => (be ? [v >> 8, v] : [v, v >> 8]).forEach(u8);
  const u32 = (v: number, be = false) => (be ? [v >>> 24, v >>> 16, v >>> 8, v] : [v, v >>> 8, v >>> 16, v >>> 24]).forEach(u8);
  const be = !!opts.bigEndianRecords;
  const T0 = 1_000_000_000;

  // Définition locale 0 : record (20)
  u8(0x40); u8(0); u8(be ? 1 : 0); u16(20, be); u8(6);
  [[253, 4, 0x86], [5, 4, 0x86], [78, 4, 0x86], [6, 2, 0x84], [4, 1, 0x02], [53, 1, 0x02]].forEach(([n, s, t]) => { u8(n); u8(s); u8(t); });
  // Définition locale 1 : record sans timestamp (pour les en-têtes compressés)
  u8(0x41); u8(0); u8(0); u16(20); u8(3);
  [[5, 4, 0x86], [78, 4, 0x86], [4, 1, 0x02]].forEach(([n, s, t]) => { u8(n); u8(s); u8(t); });
  // Définition locale 2 : session (18), sport
  u8(0x42); u8(0); u8(0); u16(18); u8(1); u8(5); u8(1); u8(0x00);

  points.forEach((p, i) => {
    const ts = T0 + Math.round(p.t);
    const alt = Math.round((p.alt + 500) * 5);
    if (opts.compressEvery && i > 0 && i % opts.compressEvery === 0) {
      u8(0x80 | (1 << 5) | (ts & 0x1f));
      u32(Math.round(p.dist * 100)); u32(alt); u8(Math.floor(p.strides));
    } else {
      u8(0x00);
      u32(ts, be); u32(Math.round(p.dist * 100), be); u32(alt, be); u16(Math.round(p.speed * 1000), be);
      u8(Math.floor(p.strides)); u8(Math.round((p.strides % 1) * 128));
    }
  });
  u8(0x02); u8(opts.sport ?? 1);

  const header = [14, 0x20, ...[2132 & 0xff, 2132 >> 8], ...[out.length, out.length >>> 8, out.length >>> 16, out.length >>> 24], 46, 70, 73, 84];
  const h = Uint8Array.from(header);
  const hcrc = fitCrc(h);
  const body = Uint8Array.from([...header, hcrc & 0xff, hcrc >> 8, ...out]);
  const crc = fitCrc(body) ^ (opts.corruptCrc ? 0xffff : 0);
  return Uint8Array.from([...body, crc & 0xff, crc >> 8]);
}

/** Sortie vallonnée simulée, cadence = vraie loi + bruit. */
export function simulateRun(law: { k0: number; kv: number; up: number; down: number }, opts: { minutes?: number; hilly?: boolean; seed?: number } = {}): FitPoint[] {
  let a = opts.seed ?? 5;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  const pts: FitPoint[] = [];
  let dist = 0;
  const seconds = (opts.minutes ?? 60) * 60;
  const altAt = (d: number) => (opts.hilly === false ? 100 : 100 + 40 * Math.sin(d / 600) + 15 * Math.sin(d / 170));
  for (let t = 0; t <= seconds; t++) {
    const grade = (altAt(dist + 1) - altAt(dist)) * 100; // % sur 1 m
    const kmh = 11 - 0.25 * grade + 1.2 * Math.sin(t / 97) + rand() * 0.4; // ralentit en montée
    const steps = law.k0 + law.kv * kmh + (grade > 0 ? law.up * grade : -law.down * grade) + rand() * 2;
    pts.push({ t, dist, alt: altAt(dist) + rand() * 0.6, speed: kmh / 3.6, strides: steps / 2 });
    dist += kmh / 3.6;
  }
  return pts;
}
