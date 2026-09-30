import './style.css';
import { AUDIO_EXTENSIONS, matchAudioFiles } from '../core/audioMatch';
import { demoLibrary } from '../core/demo';
import { toCsv, toJson, toM3U } from '../core/export';
import { formatDuration, mergeLibraries, parseLibraryFile, type Song } from '../core/library';
import { cadenceAt, distanceAt, estimateCadence, planRun, type PacingMode, type RunPlan } from '../core/pacing';
import { generatePlaylist, type Playlist } from '../core/playlist';
import { parseRouteFile, type Route } from '../core/route';
import { elevationStats, smoothedProfile, splitSections } from '../core/sections';
import { renderChart } from './chart';
import { RunPlayer, type PlayerSnapshot, type PlayerTrack } from './player';
import { SpotifyPanel } from './spotifyPanel';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LIBRARY_KEY = 'runbpm.library';

const state: {
  route?: Route;
  library: Song[];
  seed: number;
  /** Fichiers audio choisis par l'utilisateur (non mémorisés : à resélectionner après rechargement). */
  audioFiles: File[];
  /** Fichier audio associé à chaque morceau (par identifiant). */
  audioBySong: Map<string, File>;
  current?: { plan: RunPlan; playlist: Playlist };
} = { library: loadLibrary(), seed: 1, audioFiles: [], audioBySong: new Map() };
let lastExport: { m3u: string; csv: string; json: string } | undefined;
let playerSignature = '';

/** Réglages du formulaire conservés pendant l'aller-retour de connexion à Spotify. */
const SETTINGS_IDS = ['pace', 'speed', 'mode', 'base-cadence', 'uphill', 'downhill', 'tolerance', 'stretch', 'half-time', 'repeat', 'm-fallback', 'm-overlay', 'm-volume'];
const PENDING_KEY = 'runbpm.pending';

/** Morceau lu via Spotify : pas de fichier local, identifiant Spotify connu, compte connecté. */
function playsOnSpotify(song: Song): boolean {
  return spotify.connected && !!song.spotifyUri && !state.audioBySong.has(song.id);
}

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
      .replace(/[\u0300-\u036f]/g, '')
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
  rematchAudio();
  update(errors, warnings);
});

$('library-demo').addEventListener('click', () => {
  state.library = mergeLibraries(state.library, demoLibrary());
  saveLibrary();
  renderLibrarySummary();
  rematchAudio();
  update();
});

$('library-clear').addEventListener('click', () => {
  state.library = [];
  saveLibrary();
  renderLibrarySummary();
  rematchAudio();
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
    state.current = undefined;
    loadPlayer([]);
    renderAudioSummary();
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
    // Spotify ne permet pas de changer la vitesse de lecture.
    canStretch: (song) => !playsOnSpotify(song),
  });

  showMessages(errors, [...extraWarnings, ...playlist.warnings]);
  $('results').hidden = false;
  state.current = { plan, playlist };

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
      const audioTag = state.audioBySong.has(e.song.id)
        ? ' <span class="tag audio" title="Fichier audio associé">♪ audio</span>'
        : playsOnSpotify(e.song)
          ? ' <span class="tag spotify" title="Lu via Spotify (tempo original)">Spotify</span>'
          : '';
      return `<tr class="${ok ? '' : 'off'}" data-i="${i}">
        <td><button type="button" class="row-play" data-i="${i}" aria-label="Lire le morceau ${i + 1}" title="Lire à partir d’ici">${i + 1}</button></td>
        <td>${formatDuration(e.startTime)}</td>
        <td>${km(distanceAt(plan, e.startTime), 1)}</td>
        <td><div class="song-title">${esc(e.song.title)}${e.repeated ? ' <span class="tag">bis</span>' : ''}</div><div class="muted small">${esc(e.song.artist)}${audioTag}</div></td>
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

  loadPlayer(
    playlist.entries.map((entry) => ({
      entry,
      file: state.audioBySong.get(entry.song.id),
      spotifyUri: playsOnSpotify(entry.song) ? entry.song.spotifyUri : undefined,
    })),
  );
  $('export-spotify').hidden = !spotify.connected;
  renderPlayer(player.snapshot());
  renderAudioSummary();

  const title = `RunBPM – ${route.name} – ${formatPace(pace)}/km`;
  lastExport = {
    m3u: toM3U(playlist, title),
    csv: toCsv(playlist),
    json: toJson(plan, playlist, { route: route.name, targetPace: formatPace(pace) }),
  };
}

// ---------- Lecteur ----------

const player = new RunPlayer((snap) => renderPlayer(snap));
const seekInput = $<HTMLInputElement>('p-seek');
let seeking = false;

/** Recharge le lecteur seulement si la playlist ou les fichiers associés ont changé. */
function loadPlayer(tracks: PlayerTrack[]): void {
  const signature = tracks
    .map((t) => `${t.entry.song.id}@${t.entry.playbackRate}:${t.file ? `${t.file.name}/${t.file.size}` : ''}:${t.spotifyUri ?? ''}`)
    .join('|');
  if (signature === playerSignature) return;
  playerSignature = signature;
  player.load(tracks);
}

function rematchAudio(): void {
  const matches = matchAudioFiles(
    state.library,
    state.audioFiles.map((f) => f.webkitRelativePath || f.name),
  );
  state.audioBySong = new Map([...matches].map(([id, i]) => [id, state.audioFiles[i]]));
}

function renderAudioSummary(): void {
  const el = $('player-assoc');
  if (state.audioFiles.length === 0) {
    el.textContent = spotify.connected
      ? 'Aucun fichier audio : morceaux liés lus via Spotify, les autres au métronome.'
      : 'Aucun fichier audio : le métronome donne la cadence.';
    return;
  }
  const inPlaylist = state.current?.playlist.entries.filter((e) => state.audioBySong.has(e.song.id)).length ?? 0;
  const total = state.current?.playlist.entries.length ?? 0;
  const unmatched = state.audioFiles.length - state.audioBySong.size;
  el.textContent =
    `${state.audioBySong.size} fichier(s) associé(s) à la bibliothèque` +
    (total ? ` · ${inPlaylist}/${total} morceaux de la playlist` : '') +
    (unmatched ? ` · ${unmatched} sans correspondance` : '');
}

function addAudioFiles(list: FileList | null): void {
  const files = Array.from(list ?? []).filter((f) => f.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(f.name));
  const key = (f: File) => `${f.webkitRelativePath || f.name}/${f.size}`;
  const known = new Set(state.audioFiles.map(key));
  state.audioFiles = [...state.audioFiles, ...files.filter((f) => !known.has(key(f)))];
  rematchAudio();
  update();
}

for (const id of ['audio-files', 'audio-folder']) {
  $<HTMLInputElement>(id).addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    addAudioFiles(input.files);
    input.value = '';
  });
}

function renderPlayer(snap: PlayerSnapshot): void {
  $('p-play').classList.toggle('playing', snap.playing);
  $('p-play').setAttribute('aria-label', snap.playing ? 'Pause' : 'Lecture');
  const entry = state.current?.playlist.entries[snap.index];
  const plan = state.current?.plan;

  if (!entry || !plan) {
    $('p-title').textContent = '—';
    $('p-sub').innerHTML = '&nbsp;';
    $('p-cad').textContent = '—';
  } else {
    $('p-title').textContent = `${snap.index + 1}. ${entry.song.title}`;
    const source =
      snap.mode === 'audio'
        ? 'fichier audio'
        : snap.mode === 'spotify'
          ? 'Spotify'
          : snap.mode === 'metronome'
            ? 'métronome (pas de fichier)'
            : 'ignoré (pas de fichier)';
    const rate = entry.playbackRate === 1 ? 'tempo original' : `tempo ${entry.playbackRate > 1 ? '+' : ''}${((entry.playbackRate - 1) * 100).toFixed(1)} %`;
    $('p-sub').textContent = `${entry.song.artist} · ${entry.song.bpm} BPM${entry.multiplier === 2 ? ' ×2' : ''} · ${rate} · ${source}`;
    $('p-cad').textContent = String(Math.round(entry.effectiveCadence));
    const runTime = entry.startTime + snap.position;
    const done = runTime >= plan.totalTime;
    $('p-run').textContent = done
      ? 'Arrivée !'
      : `km ${km(distanceAt(plan, runTime), 1)} · cible ${cadenceAt(plan, runTime)} pas/min`;
  }
  $('p-pos').textContent = formatDuration(snap.position);
  $('p-dur').textContent = formatDuration(snap.duration);
  if (!seeking) seekInput.value = String(snap.duration > 0 ? Math.round((snap.position / snap.duration) * 1000) : 0);

  const err = $('p-error');
  err.hidden = !snap.error;
  err.textContent = snap.error ?? '';

  for (const row of $('playlist').querySelectorAll<HTMLTableRowElement>('tbody tr')) {
    row.classList.toggle('current', Number(row.dataset.i) === snap.index && (snap.playing || snap.position > 0));
  }
}

$('p-play').addEventListener('click', () => player.toggle());
$('p-next').addEventListener('click', () => player.next());
$('p-prev').addEventListener('click', () => player.previous());
seekInput.addEventListener('input', () => (seeking = true));
seekInput.addEventListener('change', () => {
  seeking = false;
  player.seek(Number(seekInput.value) / 1000);
});
$('playlist').addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button.row-play');
  if (btn) player.jump(Number(btn.dataset.i));
});

function syncPlayerOptions(): void {
  player.setOptions({
    metronomeFallback: $<HTMLInputElement>('m-fallback').checked,
    metronomeOverlay: $<HTMLInputElement>('m-overlay').checked,
    metronomeVolume: Number($<HTMLInputElement>('m-volume').value) / 100,
  });
}
for (const id of ['m-fallback', 'm-overlay', 'm-volume']) $(id).addEventListener('input', syncPlayerOptions);
syncPlayerOptions();

// Barre d'espace = lecture / pause (hors champs de saisie).
document.addEventListener('keydown', (ev) => {
  const target = ev.target as HTMLElement;
  if (ev.code !== 'Space' || $('results').hidden || target.closest('input, select, textarea, button')) return;
  ev.preventDefault();
  player.toggle();
});

const base = () => `runbpm-${slug(state.route?.name ?? 'parcours')}`;
$('export-m3u').addEventListener('click', () => lastExport && download(`${base()}.m3u`, lastExport.m3u, 'audio/x-mpegurl'));
$('export-csv').addEventListener('click', () => lastExport && download(`${base()}.csv`, lastExport.csv, 'text/csv'));
$('export-json').addEventListener('click', () => lastExport && download(`${base()}.json`, lastExport.json, 'application/json'));

// ---------- Spotify ----------

const spotify = new SpotifyPanel($('spotify-card'), {
  onConnectionChange: () => {
    player.setRemote(spotify.remote);
    update();
  },
  getLibrary: () => state.library,
  onLibraryChanged: () => {
    saveLibrary();
    update();
  },
  beforeRedirect: () => {
    // La connexion quitte la page : on garde le parcours et les réglages pour le retour.
    try {
      const settings = Object.fromEntries(
        SETTINGS_IDS.map((id) => {
          const el = $<HTMLInputElement>(id);
          return [id, el.type === 'checkbox' ? el.checked : el.value];
        }),
      );
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ route: state.route, settings }));
    } catch {
      /* stockage indisponible : il faudra recharger le parcours */
    }
  },
});

function restorePending(): void {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    if (!raw) return;
    const { route, settings } = JSON.parse(raw) as { route?: Route; settings?: Record<string, string | boolean> };
    for (const [id, value] of Object.entries(settings ?? {})) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = value === true;
      else el.value = String(value);
    }
    syncPlayerOptions();
    if (route?.points?.length) setRoute(route);
  } catch {
    /* rien à restaurer */
  }
}

$('export-spotify').addEventListener('click', async () => {
  const status = $('spotify-export-status');
  const current = state.current;
  const pace = parsePace(paceInput.value);
  if (!current || !state.route || !pace) return;
  const btn = $<HTMLButtonElement>('export-spotify');
  btn.disabled = true;
  status.hidden = false;
  status.className = 'small muted';
  status.textContent = 'Création de la playlist…';
  try {
    const name = `RunBPM – ${state.route.name} – ${formatPace(pace)}/km`;
    const description = `Cadence ${current.plan.baseCadence} pas/min environ, générée par RunBPM.`;
    const res = await spotify.exportPlaylist(current.playlist, name, description);
    status.className = 'small';
    status.innerHTML =
      `Playlist créée avec ${res.added} morceau(x) : <a href="${esc(res.url)}" target="_blank" rel="noopener">ouvrir dans Spotify</a>.` +
      (res.missing ? ` ${res.missing} morceau(x) non liés à Spotify n’y figurent pas.` : '') +
      ' Dans l’application Spotify, les morceaux sont joués au tempo original.';
  } catch (e) {
    status.className = 'small error-text';
    status.textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
  }
});

renderLibrarySummary();
rematchAudio();
restorePending();
update();
void spotify.init();
