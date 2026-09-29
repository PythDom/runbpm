import './style.css';
import { demoLibrary } from '../core/demo';
import { toCsv, toJson, toM3U } from '../core/export';
import { formatDuration, mergeLibraries, parseLibraryFile, type Song } from '../core/library';
import { distanceAt, estimateCadence, planRun, type PacingMode } from '../core/pacing';
import { generatePlaylist } from '../core/playlist';
import { parseRouteFile, type Route } from '../core/route';
import { elevationStats, smoothedProfile, splitSections } from '../core/sections';
import { renderChart } from './chart';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LIBRARY_KEY = 'runbpm.library';

const state: { route?: Route; library: Song[]; seed: number } = { library: loadLibrary(), seed: 1 };
let lastExport: { m3u: string; csv: string; json: string } | undefined;

// ---------- Utilitaires ----------

function loadLibrary(): Song[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    return raw ? (JSON.parse(raw) as Song[]) : [];
  } catch {
    return [];
  }
}

function saveLibrary(): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(state.library));
  } catch {
    /* stockage indisponible : la bibliothèque reste en mémoire */
  }
}

function parsePace(text: string): number | undefined {
  const m = /^\s*(\d{1,2})[:'’h,.](\d{1,2})\s*$/.exec(text) ?? /^\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return undefined;
  const sec = Number(m[1]) * 60 + Number(m[2] ?? 0);
  return sec >= 120 && sec <= 1200 ? sec : undefined;
}

function formatPace(secPerKm: number): string {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const km = (m: number, digits = 2) => (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function numberInput(id: string, fallback: number): number {
  const v = Number.parseFloat($<HTMLInputElement>(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function showMessages(errors: string[], warnings: string[] = []): void {
  $('messages').innerHTML = [
    ...errors.map((m) => `<p class="msg error">${esc(m)}</p>`),
    ...warnings.map((m) => `<p class="msg warning">${esc(m)}</p>`),
  ].join('');
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'parcours'
  );
}

// ---------- Parcours ----------

function setRoute(route: Route): void {
  state.route = route;
  const { gain, loss } = elevationStats(splitSections(route));
  $('route-summary').classList.remove('muted');
  $('route-summary').innerHTML =
    `<strong>${esc(route.name)}</strong><br>${km(route.totalDistance)} km · D+ ${Math.round(gain)} m · D− ${Math.round(loss)} m` +
    (route.warnings.length ? `<br><span class="warn-text">${route.warnings.map(esc).join('<br>')}</span>` : '');
  update();
}

$<HTMLInputElement>('route-file').addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    setRoute(parseRouteFile(file.name, await file.text()));
  } catch (e) {
    showMessages([`Parcours : ${(e as Error).message}`]);
  }
});

$('route-sample').addEventListener('click', async () => {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/boucle-vallonnee.gpx`);
    setRoute(parseRouteFile('boucle-vallonnee.gpx', await res.text()));
  } catch (e) {
    showMessages([`Impossible de charger l’exemple : ${(e as Error).message}`]);
  }
});

// ---------- Allure ----------

const paceInput = $<HTMLInputElement>('pace');
const speedInput = $<HTMLInputElement>('speed');

paceInput.addEventListener('input', () => {
  const pace = parsePace(paceInput.value);
  paceInput.classList.toggle('invalid', pace === undefined);
  if (pace) speedInput.value = (3600 / pace).toFixed(1);
  update();
});
speedInput.addEventListener('input', () => {
  const kmh = Number.parseFloat(speedInput.value);
  if (kmh >= 3 && kmh <= 30) {
    paceInput.value = formatPace(3600 / kmh);
    paceInput.classList.remove('invalid');
  }
  update();
});

// ---------- Bibliothèque ----------

function renderLibrarySummary(): void {
  const el = $('library-summary');
  const n = state.library.length;
  if (n === 0) {
    el.classList.add('muted');
    el.textContent = 'Aucun morceau.';
    return;
  }
  el.classList.remove('muted');
  const bpms = state.library.map((s) => s.bpm);
  const total = state.library.reduce((a, s) => a + s.duration, 0);
  el.innerHTML = `<strong>${n} morceau${n > 1 ? 'x' : ''}</strong> · ${formatDuration(total)} de musique · ${Math.min(...bpms)}–${Math.max(...bpms)} BPM`;
}

$<HTMLInputElement>('library-file').addEventListener('change', async (ev) => {
  const input = ev.target as HTMLInputElement;
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const file of Array.from(input.files ?? [])) {
    try {
      const res = parseLibraryFile(file.name, await file.text());
      state.library = mergeLibraries(state.library, res.songs);
      if (res.warnings.length) {
        warnings.push(`${file.name} : ${res.songs.length} morceau(x) importé(s), ${res.warnings.length} ignoré(s) (${res.warnings.slice(0, 3).join(' ; ')}${res.warnings.length > 3 ? '…' : ''})`);
      }
    } catch (e) {
      errors.push(`${file.name} : ${(e as Error).message}`);
    }
  }
  input.value = '';
  saveLibrary();
  renderLibrarySummary();
  update(errors, warnings);
});

$('library-demo').addEventListener('click', () => {
  state.library = mergeLibraries(state.library, demoLibrary());
  saveLibrary();
  renderLibrarySummary();
  update();
});

$('library-clear').addEventListener('click', () => {
  state.library = [];
  saveLibrary();
  renderLibrarySummary();
  update();
});

// ---------- Calcul et rendu ----------

for (const id of ['mode', 'base-cadence', 'uphill', 'downhill', 'tolerance', 'stretch', 'half-time', 'repeat']) {
  $(id).addEventListener('input', () => update());
  $(id).addEventListener('change', () => update());
}

$('reroll').addEventListener('click', () => {
  state.seed += 1;
  update();
});

function update(extraErrors: string[] = [], extraWarnings: string[] = []): void {
  const pace = parsePace(paceInput.value);
  const baseCadenceInput = $<HTMLInputElement>('base-cadence');
  if (pace) baseCadenceInput.placeholder = `auto (≈ ${estimateCadence(3600 / pace)})`;

  const errors = [...extraErrors];
  if (!pace) errors.push('Allure invalide : utilisez le format min:s, par exemple 5:30.');
  if (!state.route || state.library.length === 0 || !pace) {
    $('results').hidden = true;
    lastExport = undefined;
    showMessages(errors, extraWarnings);
    return;
  }

  const route = state.route;
  const tolerance = numberInput('tolerance', 3) / 100;
  const baseCadence = Number.parseFloat(baseCadenceInput.value);
  const sections = splitSections(route);
  const plan = planRun(sections, {
    targetPace: pace,
    mode: $<HTMLSelectElement>('mode').value as PacingMode,
    baseCadence: Number.isFinite(baseCadence) ? baseCadence : undefined,
    uphillSensitivity: numberInput('uphill', 0.6),
    downhillSensitivity: numberInput('downhill', 0.3),
  });
  const playlist = generatePlaylist(plan, state.library, {
    tolerance,
    maxStretch: numberInput('stretch', 4) / 100,
    allowHalfTime: $<HTMLInputElement>('half-time').checked,
    allowRepeat: $<HTMLInputElement>('repeat').checked,
    seed: state.seed,
  });

  showMessages(errors, [...extraWarnings, ...playlist.warnings]);
  $('results').hidden = false;

  const cadences = plan.sections.map((s) => s.cadence);
  const { gain } = elevationStats(sections);
  $('stats').innerHTML = [
    ['Distance', `${km(plan.totalDistance)} km`],
    ['Dénivelé +', `${Math.round(gain)} m`],
    ['Temps estimé', formatDuration(plan.totalTime)],
    ['Cadence cible', Math.min(...cadences) === Math.max(...cadences) ? `${cadences[0]}` : `${Math.min(...cadences)}–${Math.max(...cadences)}`, 'pas/min'],
    ['Morceaux', `${playlist.entries.length}`],
    ['Dans la tolérance', `${Math.round(playlist.matchRatio * 100)} %`, 'du temps de course'],
  ]
    .map(([label, value, unit]) => `<div class="stat"><span class="label">${label}</span><span class="value">${value}</span>${unit ? `<span class="unit">${unit}</span>` : ''}</div>`)
    .join('');

  $('chart').innerHTML = renderChart(smoothedProfile(route), plan, playlist, tolerance);

  $('playlist').querySelector('tbody')!.innerHTML = playlist.entries
    .map((e, i) => {
      const ok = e.error <= tolerance + 1e-9;
      const rate = e.playbackRate === 1 ? '—' : `${e.playbackRate > 1 ? '+' : ''}${((e.playbackRate - 1) * 100).toFixed(1)} %`;
      return `<tr class="${ok ? '' : 'off'}">
        <td>${i + 1}</td>
        <td>${formatDuration(e.startTime)}</td>
        <td>${km(distanceAt(plan, e.startTime), 1)}</td>
        <td><div class="song-title">${esc(e.song.title)}${e.repeated ? ' <span class="tag">bis</span>' : ''}</div><div class="muted small">${esc(e.song.artist)}</div></td>
        <td class="num">${e.song.bpm}${e.multiplier === 2 ? ' <span class="tag" title="Un pas par demi-temps">×2</span>' : ''}</td>
        <td class="num">${rate}</td>
        <td class="num strong">${e.effectiveCadence}</td>
        <td class="num">${e.targetCadence}</td>
      </tr>`;
    })
    .join('');

  $('sections').querySelector('tbody')!.innerHTML = plan.sections
    .map(
      (s) => `<tr>
        <td>${km(s.startDist, 1)} → ${km(s.endDist, 1)}</td>
        <td class="num">${Math.round(s.length)} m</td>
        <td class="num">${s.grade >= 0 ? '+' : ''}${(s.grade * 100).toFixed(1)} %</td>
        <td class="num">${formatPace(s.pace)} /km</td>
        <td class="num strong">${s.cadence}</td>
        <td class="num">${formatDuration(s.startTime)}</td>
      </tr>`,
    )
    .join('');

  const title = `RunBPM – ${route.name} – ${formatPace(pace)}/km`;
  lastExport = {
    m3u: toM3U(playlist, title),
    csv: toCsv(playlist),
    json: toJson(plan, playlist, { route: route.name, targetPace: formatPace(pace) }),
  };
}

const base = () => `runbpm-${slug(state.route?.name ?? 'parcours')}`;
$('export-m3u').addEventListener('click', () => lastExport && download(`${base()}.m3u`, lastExport.m3u, 'audio/x-mpegurl'));
$('export-csv').addEventListener('click', () => lastExport && download(`${base()}.csv`, lastExport.csv, 'text/csv'));
$('export-json').addEventListener('click', () => lastExport && download(`${base()}.json`, lastExport.json, 'application/json'));

renderLibrarySummary();
update();
