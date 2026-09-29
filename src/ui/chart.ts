import { formatDuration } from '../core/library';
import { distanceAt, type RunPlan } from '../core/pacing';
import type { Playlist } from '../core/playlist';
import type { ProfileSample } from '../core/sections';

const W = 1000;
const H = 340;
const M = { top: 16, right: 48, bottom: 64, left: 48 };
const SONG_BAR = 22;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}

/**
 * Graphique SVG : profil d'altitude (aire), cadence cible (ligne en escalier, axe de droite)
 * et bandeau des morceaux placés sur la distance où ils seront écoutés.
 */
export function renderChart(profile: ProfileSample[], plan: RunPlan, playlist: Playlist, tolerance: number): string {
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom - SONG_BAR - 8;
  const total = plan.totalDistance;
  const x = (d: number) => M.left + (d / total) * plotW;

  const eles = profile.map((p) => p.ele);
  let eMin = Math.min(...eles);
  let eMax = Math.max(...eles);
  if (eMax - eMin < 20) {
    const mid = (eMax + eMin) / 2;
    eMin = mid - 10;
    eMax = mid + 10;
  }
  const ePad = (eMax - eMin) * 0.1;
  eMin -= ePad;
  eMax += ePad;
  const yE = (e: number) => M.top + plotH - ((e - eMin) / (eMax - eMin)) * plotH;

  const cads = plan.sections.map((s) => s.cadence).concat(playlist.entries.map((e) => e.effectiveCadence));
  let cMin = Math.min(...cads) - 4;
  let cMax = Math.max(...cads) + 4;
  if (cMax - cMin < 16) {
    const mid = (cMax + cMin) / 2;
    cMin = mid - 8;
    cMax = mid + 8;
  }
  const yC = (c: number) => M.top + plotH - ((c - cMin) / (cMax - cMin)) * plotH;

  const parts: string[] = [];

  // Grille + axe altitude (gauche)
  const eStep = niceStep(eMax - eMin, 4);
  for (let e = Math.ceil(eMin / eStep) * eStep; e <= eMax; e += eStep) {
    parts.push(`<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${yE(e)}" y2="${yE(e)}"/>`);
    parts.push(`<text class="axis" x="${M.left - 6}" y="${yE(e) + 4}" text-anchor="end">${Math.round(e)}</text>`);
  }
  parts.push(`<text class="axis-title" x="${M.left - 6}" y="${M.top - 4}" text-anchor="end">m</text>`);

  // Axe cadence (droite)
  const cStep = niceStep(cMax - cMin, 4);
  for (let c = Math.ceil(cMin / cStep) * cStep; c <= cMax; c += cStep) {
    parts.push(`<text class="axis cad-axis" x="${W - M.right + 6}" y="${yC(c) + 4}">${Math.round(c)}</text>`);
  }
  parts.push(`<text class="axis-title cad-axis" x="${W - 4}" y="${M.top - 4}" text-anchor="end">pas/min</text>`);

  // Aire d'altitude
  const base = M.top + plotH;
  const line = profile.map((p) => `${x(p.dist).toFixed(1)},${yE(p.ele).toFixed(1)}`).join(' L');
  parts.push(`<path class="elev-area" d="M${x(0)},${base} L${line} L${x(total)},${base} Z"/>`);
  parts.push(`<path class="elev-line" d="M${line}"/>`);

  // Cadence cible en escalier
  const steps = plan.sections
    .map((s) => `L${x(s.startDist).toFixed(1)},${yC(s.cadence).toFixed(1)} L${x(s.endDist).toFixed(1)},${yC(s.cadence).toFixed(1)}`)
    .join(' ');
  parts.push(`<path class="cad-line" d="M${steps.slice(1)}"/>`);

  // Cadence imposée par chaque morceau (tirets)
  for (const e of playlist.entries) {
    const d0 = distanceAt(plan, e.startTime);
    const d1 = distanceAt(plan, e.endTime);
    if (d1 <= d0) continue;
    parts.push(
      `<line class="song-cad" x1="${x(d0)}" x2="${x(d1)}" y1="${yC(e.effectiveCadence)}" y2="${yC(e.effectiveCadence)}"/>`,
    );
  }

  // Bandeau des morceaux
  const barY = base + 8;
  playlist.entries.forEach((e, i) => {
    const d0 = distanceAt(plan, e.startTime);
    const d1 = distanceAt(plan, e.endTime);
    if (d1 <= d0) return;
    const cls = e.error <= tolerance + 1e-9 ? 'ok' : 'warn';
    const w = Math.max(1, x(d1) - x(d0) - 1.5);
    const label = `${i + 1}. ${e.song.artist} – ${e.song.title}\n${formatDuration(e.startTime)} · ${e.effectiveCadence} pas/min (cible ${e.targetCadence})`;
    parts.push(
      `<g class="song ${cls} ${i % 2 ? 'alt' : ''}"><title>${esc(label)}</title>` +
        `<rect x="${x(d0)}" y="${barY}" width="${w}" height="${SONG_BAR}" rx="3"/>` +
        (w > 22 ? `<text x="${x(d0) + w / 2}" y="${barY + SONG_BAR / 2 + 4}" text-anchor="middle">${i + 1}</text>` : '') +
        `</g>`,
    );
  });

  // Axe des distances
  const dStep = niceStep(total / 1000, 8) * 1000;
  for (let d = 0; d <= total + 1; d += dStep) {
    parts.push(`<text class="axis" x="${x(d)}" y="${H - 14}" text-anchor="middle">${(d / 1000).toLocaleString('fr-FR')}</text>`);
  }
  parts.push(`<text class="axis-title" x="${W - M.right}" y="${H - 14}" text-anchor="start" dx="6">km</text>`);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil du parcours, cadence cible et morceaux">${parts.join('')}</svg>`;
}
