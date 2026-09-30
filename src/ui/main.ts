import './style.css';
import { demoLibrary } from '../core/demo';
import { toCsv, toJson, toM3U, toTransferText } from '../core/export';
import { formatDuration, mergeLibraries, parseLibraryFile, type Song } from '../core/library';
import { cadenceAt, distanceAt, estimateCadence, planRun, type PacingMode, type RunPlan } from '../core/pacing';
import { generatePlaylist, type Playlist } from '../core/playlist';
import { parseRouteFile, type Route } from '../core/route';
import { elevationStats, smoothedProfile, splitSections } from '../core/sections';
import { analyzeFiles, fileKey } from './analyzer';
import { renderChart } from './chart';
import { RunCompanion, type CompanionSnapshot } from './companion';
import { LibraryView, LOW_CONFIDENCE, NO_PULSE } from './libraryView';
import { importNavidrome } from './navidromeImport';
import { NavidromePanel } from './navidromePanel';
import { RunPlayer, type PlayerSnapshot, type PlayerTrack } from './player';
import { SpotifyPanel } from './spotifyPanel';

type Service = 'navidrome' | 'spotify' | 'deezer' | 'none';
const SERVICES: Service[] = ['navidrome', 'spotify', 'deezer', 'none'];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LIBRARY_KEY = 'runbpm.library';
const SERVICE_KEY = 'runbpm.service';
/** Réglages du formulaire conservés pendant l'aller-retour de connexion à Spotify. */
const SETTINGS_IDS = ['pace', 'speed', 'mode', 'base-cadence', 'uphill', 'downhill', 'tolerance', 'stretch', 'half-time', 'repeat', 'use-tag-bpm', 'm-volume', 'm-overlay', 'keep-awake'];
const PENDING_KEY = 'runbpm.pending';

const state: {
  route?: Route;
  library: Song[];
  seed: number;
  current?: { plan: RunPlan; playlist: Playlist };
  analysis?: { cancelled: boolean };
} = { library: loadLibrary(), seed: 1 };
let lastExport: { m3u: string; csv: string; json: string } | undefined;
let companionSignature = '';
let playerSignature = '';
let companionSynced = false;

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
    /* stockage indisponible ou plein : la bibliothèque reste en mémoire */
  }
}

function service(): Service {
  return $<HTMLSelectElement>('service').value as Service;
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

function playlistName(): string {
  const pace = parsePace($<HTMLInputElement>('pace').value);
  return `RunBPM – ${state.route?.name ?? 'course'}${pace ? ` – ${formatPace(pace)}/km` : ''}`;
}

function setServiceStatus(html: string, kind: 'muted' | 'ok' | 'error' = 'muted', isHtml = false): void {
  const el = $('service-status');
  el.hidden = !html;
  el.className = `small ${kind === 'error' ? 'error-text' : kind === 'muted' ? 'muted' : ''}`;
  if (isHtml) el.innerHTML = html;
  else el.textContent = html;
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

const libraryView = new LibraryView(
  $('library-view'),
  () => state.library,
  () => {
    saveLibrary();
    renderLibrarySummary();
    update();
  },
);

function renderLibrarySummary(): void {
  const el = $('library-summary');
  const n = state.library.length;
  if (n === 0) {
    el.classList.add('muted');
    el.textContent = 'Aucun morceau.';
    return;
  }
  el.classList.remove('muted');
  const running = state.library.filter((s) => s.bpm >= 145 || (s.bpm >= 72 && s.bpm <= 100)).length;
  const doubtful = state.library.filter((s) => s.confidence !== undefined && s.confidence < LOW_CONFIDENCE).length;
  const total = state.library.reduce((a, s) => a + s.duration, 0);
  el.innerHTML =
    `<strong>${n} morceau${n > 1 ? 'x' : ''}</strong> · ${formatDuration(total)} de musique<br>` +
    `${running} au tempo de course (≥ 145 ou 72–100 BPM)` +
    (doubtful ? ` · <span class="warn-text">${doubtful} à vérifier</span>` : '');
}

function libraryChanged(): void {
  saveLibrary();
  renderLibrarySummary();
  libraryView.render();
  update();
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
  libraryView.render();
  update(errors, warnings);
});

$('library-demo').addEventListener('click', () => {
  state.library = mergeLibraries(state.library, demoLibrary());
  libraryChanged();
});

$('library-clear').addEventListener('click', () => {
  if (state.library.length > 20 && !confirm(`Retirer les ${state.library.length} morceaux de la bibliothèque ?`)) return;
  state.library = [];
  libraryChanged();
});

// ---------- Analyse des fichiers audio ----------

async function analyze(list: FileList | null): Promise<void> {
  const files = Array.from(list ?? []);
  if (files.length === 0 || state.analysis) return;
  const signal = { cancelled: false };
  state.analysis = signal;
  const box = $('analysis');
  const bar = $<HTMLProgressElement>('analysis-bar');
  const text = $('analysis-text');
  box.hidden = false;
  const known = new Set(state.library.map((s) => s.fileKey).filter((k): k is string => !!k));
  const skipped = files.filter((f) => known.has(fileKey(f))).length;
  let sinceSave = 0;
  const started = performance.now();

  const { progress, errors } = await analyzeFiles(
    files,
    known,
    { useTagBpm: $<HTMLInputElement>('use-tag-bpm').checked },
    (song) => {
      state.library = mergeLibraries(state.library, [song]);
      if (++sinceSave >= 20) {
        sinceSave = 0;
        saveLibrary();
        renderLibrarySummary();
      }
    },
    (p) => {
      bar.max = Math.max(1, p.total);
      bar.value = p.done;
      const elapsed = (performance.now() - started) / 1000;
      const eta = p.done > 2 ? (elapsed / p.done) * (p.total - p.done) : undefined;
      text.textContent =
        `${p.done}/${p.total} fichier(s) analysé(s)` +
        (eta !== undefined && p.done < p.total ? ` · environ ${formatDuration(eta)} restant` : '') +
        (p.current ? ` · ${p.current}` : '');
    },
    signal,
  );

  state.analysis = undefined;
  box.hidden = true;
  libraryChanged();
  const summary =
    `Analyse ${signal.cancelled ? 'interrompue' : 'terminée'} : ${progress.added} morceau(x) ajouté(s)` +
    (skipped ? `, ${skipped} déjà connu(s)` : '') +
    (progress.failed ? `, ${progress.failed} fichier(s) ignoré(s)` : '') +
    '.';
  const details = errors.slice(0, 5).join(' ; ') + (errors.length > 5 ? ` ; … (${errors.length - 5} autres)` : '');
  showMessages([], errors.length ? [summary, `Fichiers ignorés : ${details}`] : [summary]);
}

for (const id of ['audio-folder', 'audio-files']) {
  $<HTMLInputElement>(id).addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    void analyze(input.files).finally(() => (input.value = ''));
  });
}
$('analysis-stop').addEventListener('click', () => {
  if (state.analysis) state.analysis.cancelled = true;
});

// ---------- Streaming ----------

const spotify = new SpotifyPanel($('spotify-panel'), {
  onConnectionChange: () => update(),
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

// Navidrome / Subsonic : lecture dans RunBPM avec ajustement du tempo.
let navidromeImport: { cancelled: boolean } | undefined;

const navidrome = new NavidromePanel($('navidrome-panel'), {
  onConnectionChange: () => update(),
  onImport: () => void runNavidromeImport(),
  onStopImport: () => {
    if (navidromeImport) navidromeImport.cancelled = true;
  },
});

async function runNavidromeImport(): Promise<void> {
  const client = navidrome.client;
  if (!client || navidromeImport) return;
  const signal = { cancelled: false };
  navidromeImport = signal;
  let sinceSave = 0;
  const started = performance.now();
  try {
    const { progress, errors } = await importNavidrome(
      client,
      state.library,
      { useTagBpm: $<HTMLInputElement>('use-tag-bpm').checked },
      (song) => {
        state.library = mergeLibraries(state.library, [song]);
        if (++sinceSave >= 20) {
          sinceSave = 0;
          saveLibrary();
          renderLibrarySummary();
        }
      },
      (p) => {
        const elapsed = (performance.now() - started) / 1000;
        const eta = p.phase === 'analyse' && p.done > 2 ? (elapsed / p.done) * (p.total - p.done) : undefined;
        navidrome.setImportProgress({
          done: p.done,
          total: p.phase === 'liste' ? p.done + 1 : p.total,
          text:
            p.phase === 'liste'
              ? `Lecture du catalogue : ${p.done} morceaux…`
              : `Tempo : ${p.done}/${p.total}` + (eta !== undefined ? ` · environ ${formatDuration(eta)} restant` : '') + (p.current ? ` · ${p.current}` : ''),
        });
      },
      signal,
    );
    const summary =
      `Import ${signal.cancelled ? 'interrompu' : 'terminé'} : ${progress.added} morceau(x) ajouté(s)` +
      (progress.linked ? `, ${progress.linked} déjà connu(s) relié(s) au serveur` : '') +
      (progress.failed ? `, ${progress.failed} ignoré(s)` : '') +
      '.';
    navidrome.setImportProgress(undefined, summary);
    if (errors.length) showMessages([], [`Morceaux ignorés : ${errors.slice(0, 5).join(' ; ')}${errors.length > 5 ? ` ; … (${errors.length - 5} autres)` : ''}`]);
  } catch (e) {
    navidrome.setImportProgress(undefined, (e as Error).message, true);
  } finally {
    navidromeImport = undefined;
    libraryChanged();
  }
}

$('create-navidrome').addEventListener('click', async () => {
  const client = navidrome.client;
  const current = state.current;
  if (!client || !current) return;
  try {
    setServiceStatus('Création de la playlist dans Navidrome…');
    await client.createPlaylist(playlistName(), current.playlist.entries.map((e) => e.song.navidromeId!));
    setServiceStatus(
      `Playlist « ${playlistName()} » créée dans Navidrome (${current.playlist.entries.length} morceaux). ` +
        'Les autres applications la lisent au tempo original ; l’ajustement du tempo n’existe que dans RunBPM.',
      'ok',
    );
  } catch (e) {
    setServiceStatus((e as Error).message, 'error');
  }
});

function renderService(): void {
  const s = service();
  $('navidrome-panel').hidden = s !== 'navidrome';
  $('stretch-row').hidden = s !== 'navidrome';
  $('overlay-row').hidden = s !== 'navidrome';
  $('run-seek').hidden = s !== 'navidrome';
  $('spotify-panel').hidden = s !== 'spotify';
  $('deezer-panel').hidden = s !== 'deezer';
  $('none-panel').hidden = s !== 'none';
  try {
    localStorage.setItem(SERVICE_KEY, s);
  } catch {
    /* préférence non mémorisée */
  }
}

$('service').addEventListener('change', () => {
  renderService();
  setServiceStatus('');
  update();
});

/**
 * Crée la playlist Spotify. Les morceaux de la playlist sont cherchés sur Spotify ; ceux qui en sont
 * absents sont exclus et la playlist est recalculée, jusqu'à ce qu'elle soit entièrement disponible
 * (sinon la musique et le métronome se décaleraient pendant la course).
 */
async function createSpotifyPlaylist(): Promise<void> {
  const btn = $<HTMLButtonElement>('create-spotify');
  btn.disabled = true;
  try {
    for (let round = 0; round < 10; round++) {
      update();
      const current = state.current;
      if (!current) throw new Error('Aucune playlist à créer.');
      const missing = [...new Set(current.playlist.entries.map((e) => e.song))].filter((s) => !s.spotifyUri);
      if (missing.length === 0) {
        setServiceStatus('Création de la playlist dans votre compte Spotify…');
        const url = await spotify.createPlaylist(
          current.playlist,
          playlistName(),
          `Cadence ≈ ${current.plan.baseCadence} pas/min. Générée par RunBPM.`,
        );
        setServiceStatus(
          `Playlist créée (${current.playlist.entries.length} morceaux) : <a href="${esc(url)}" target="_blank" rel="noopener">ouvrir dans Spotify</a>. ` +
            'Le jour de la course : lancez-la depuis l’application Spotify, puis appuyez sur Départ ci-dessus.',
          'ok',
          true,
        );
        return;
      }
      await spotify.linkSongs(missing, (done, total) =>
        setServiceStatus(`Recherche des morceaux sur Spotify : ${done}/${total}${round > 0 ? ' (remplacement des morceaux introuvables)' : ''}…`),
      );
      saveLibrary();
    }
    throw new Error('Trop de morceaux introuvables sur Spotify : élargissez la bibliothèque ou la tolérance.');
  } catch (e) {
    setServiceStatus((e as Error).message, 'error');
  } finally {
    btn.disabled = false;
    update();
  }
}

$('create-spotify').addEventListener('click', () => void createSpotifyPlaylist());

$('export-deezer').addEventListener('click', () => {
  if (!state.current) return;
  download(`${base()}-deezer.txt`, toTransferText(state.current.playlist), 'text/plain');
  setServiceStatus(
    'Liste téléchargée (« Artiste - Titre », une ligne par morceau). Importez-la dans Deezer avec un service de transfert ' +
      '(TuneMyMusic, Soundiiz…) en conservant l’ordre, puis lancez la playlist et appuyez sur Départ au même moment.',
    'ok',
  );
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
  stopOtherMode();
  const pace = parsePace(paceInput.value);
  const baseCadenceInput = $<HTMLInputElement>('base-cadence');
  if (pace) baseCadenceInput.placeholder = `auto (≈ ${estimateCadence(3600 / pace)})`;

  const errors = [...extraErrors];
  if (!pace) errors.push('Allure invalide : utilisez le format min:s, par exemple 5:30.');
  const svc = service();
  // On écarte les morceaux sans pulsation détectée ; pour Spotify, ceux qu'il ne propose pas ;
  // pour Navidrome, ceux qui ne sont pas sur le serveur.
  const notFound = svc === 'spotify' ? spotify.notFound() : new Set<string>();
  const library = state.library.filter(
    (s) =>
      !notFound.has(s.id) &&
      !(s.confidence !== undefined && s.confidence < NO_PULSE) &&
      (svc !== 'navidrome' || (navidrome.connected && !!s.navidromeId)),
  );
  if (svc === 'navidrome' && state.library.length > 0 && library.length === 0) {
    extraWarnings = [
      ...extraWarnings,
      navidrome.connected
        ? 'Aucun morceau du serveur dans la bibliothèque : cliquez sur « Importer la bibliothèque du serveur ».'
        : 'Connectez-vous à votre serveur Navidrome (carte Streaming).',
    ];
  }

  if (!state.route || library.length === 0 || !pace) {
    $('results').hidden = true;
    lastExport = undefined;
    state.current = undefined;
    loadCompanion(undefined);
    loadPlayer([]);
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
  // Les applications de streaming jouent au tempo original ; seul le lecteur interne (Navidrome)
  // peut ajuster la vitesse de lecture.
  const playlist = generatePlaylist(plan, library, {
    tolerance,
    maxStretch: svc === 'navidrome' ? numberInput('stretch', 4) / 100 : 0,
    allowHalfTime: $<HTMLInputElement>('half-time').checked,
    allowRepeat: $<HTMLInputElement>('repeat').checked,
    seed: state.seed,
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
      const tags = [
        svc === 'spotify' && e.song.spotifyUri ? '<span class="tag spotify" title="Trouvé sur Spotify">Spotify</span>' : '',
        e.song.confidence !== undefined && e.song.confidence < LOW_CONFIDENCE ? '<span class="tag warn" title="BPM détecté avec une confiance faible">à vérifier</span>' : '',
        e.repeated ? '<span class="tag">bis</span>' : '',
      ].join(' ');
      return `<tr class="${ok ? '' : 'off'}" data-i="${i}">
        <td><button type="button" class="row-play" data-i="${i}" aria-label="Aller au morceau ${i + 1}" title="${svc === 'navidrome' ? 'Lire à partir de ce morceau' : 'Recaler le métronome sur ce morceau'}">${i + 1}</button></td>
        <td>${formatDuration(e.startTime)}</td>
        <td>${km(distanceAt(plan, e.startTime), 1)}</td>
        <td><div class="song-title">${esc(e.song.title)}</div><div class="muted small">${esc(e.song.artist)} ${tags}</div></td>
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

  $('create-spotify').hidden = svc !== 'spotify' || !spotify.connected;
  $('export-deezer').hidden = svc !== 'deezer';
  $('create-navidrome').hidden = svc !== 'navidrome' || !navidrome.connected;
  if (svc === 'navidrome') {
    const client = navidrome.client!;
    loadPlayer(playlist.entries.map((entry) => ({ entry, url: client.streamUrl(entry.song.navidromeId!) })));
    loadCompanion(undefined);
    renderPlayerRun(player.snapshot());
    lastExport = {
      m3u: toM3U(playlist, playlistName()),
      csv: toCsv(playlist),
      json: toJson(plan, playlist, { route: route.name, targetPace: formatPace(pace) }),
    };
    return;
  }
  loadPlayer([]);
  loadCompanion(playlist);
  const syncWanted = svc === 'spotify' && spotify.connected;
  if (syncWanted !== companionSynced) {
    companionSynced = syncWanted;
    companion.setSync(syncWanted ? spotify.syncSource : undefined);
  }
  renderRun(companion.snapshot());

  lastExport = {
    m3u: toM3U(playlist, playlistName()),
    csv: toCsv(playlist),
    json: toJson(plan, playlist, { route: route.name, targetPace: formatPace(pace) }),
  };
}

// ---------- Pendant la course ----------

const companion = new RunCompanion((snap) => renderRun(snap));

/** Recharge le compagnon seulement si la playlist a changé (évite de l'arrêter en pleine course). */
function loadCompanion(playlist: Playlist | undefined): void {
  const signature = playlist ? playlist.entries.map((e) => `${e.song.id}@${e.startTime.toFixed(1)}`).join('|') : '';
  if (signature === companionSignature) return;
  companionSignature = signature;
  companion.setPlaylist(playlist);
}

const SYNC_LABEL: Record<CompanionSnapshot['sync'], string> = {
  timer: 'Mode chronomètre',
  synced: 'Synchronisé avec Spotify',
  paused: 'Spotify en pause',
  'other-track': 'Spotify joue un morceau hors playlist',
  'no-playback': 'En attente de lecture sur Spotify',
  error: 'Spotify injoignable : mode chronomètre',
};

function renderRun(snap: CompanionSnapshot): void {
  if (service() === 'navidrome') return;
  $('run-help').classList.remove('error-text');
  const current = state.current;
  const toggle = $('run-toggle');
  toggle.classList.toggle('playing', snap.running);
  toggle.setAttribute('aria-label', snap.running ? 'Pause' : 'Départ');
  $('run-sync').textContent = SYNC_LABEL[snap.sync];
  $('run-help').textContent =
    snap.sync === 'timer' || snap.sync === 'error'
      ? 'Lancez la playlist au premier morceau et appuyez sur Départ au même moment. Si un morceau est sauté, recalez avec ◀ ▶.'
      : 'Lancez la playlist dans l’application Spotify et appuyez sur Départ : le métronome suit le morceau joué, même en cas de saut ou de pause.';
  $('run-time').textContent = formatDuration(snap.runTime);

  const entry = current && snap.index >= 0 ? current.playlist.entries[snap.index] : undefined;
  if (!current || !entry) {
    $('run-title').textContent = current && snap.index < 0 && snap.runTime > 0 ? 'Playlist terminée' : '—';
    $('run-sub').innerHTML = '&nbsp;';
    $('run-cad').textContent = '—';
    $('run-km').textContent = '';
  } else {
    $('run-title').textContent = `${snap.index + 1}. ${entry.song.title}`;
    $('run-sub').textContent = `${entry.song.artist} · ${entry.song.bpm} BPM${entry.multiplier === 2 ? ' (un pas par demi-temps)' : ''}`;
    $('run-cad').textContent = String(Math.round(entry.effectiveCadence));
    const d = distanceAt(current.plan, snap.runTime);
    $('run-km').textContent = snap.runTime >= current.plan.totalTime ? 'Arrivée !' : `km ${km(d, 1)} · cible ${cadenceAt(current.plan, snap.runTime)} pas/min`;
  }
  $('run-cad').classList.toggle('silent', !snap.clicking);

  for (const row of $('playlist').querySelectorAll<HTMLTableRowElement>('tbody tr')) {
    row.classList.toggle('current', Number(row.dataset.i) === snap.index && (snap.running || snap.runTime > 0));
  }
}

// ---------- Lecteur interne (Navidrome) ----------

const player = new RunPlayer((snap) => renderPlayerRun(snap));
const runSeek = $<HTMLInputElement>('run-seek');
let seeking = false;

/** Recharge le lecteur seulement si la playlist a changé (évite de l'arrêter en pleine course). */
function loadPlayer(tracks: PlayerTrack[]): void {
  const signature = tracks.map((t) => `${t.entry.song.id}@${t.entry.playbackRate}`).join('|');
  if (signature === playerSignature) return;
  playerSignature = signature;
  player.load(tracks);
}

/** Un seul mode actif : le lecteur interne (Navidrome) ou le compagnon (métronome seul). */
function stopOtherMode(): void {
  if (service() === 'navidrome') companion.pause();
  else player.pause();
}

function renderPlayerRun(snap: PlayerSnapshot): void {
  if (service() !== 'navidrome') return;
  const current = state.current;
  const toggle = $('run-toggle');
  toggle.classList.toggle('playing', snap.playing);
  toggle.setAttribute('aria-label', snap.playing ? 'Pause' : 'Lecture');
  $('run-sync').textContent = 'Lecture depuis Navidrome';
  $('run-help').textContent = snap.error ?? 'Les morceaux sont lus dans RunBPM, au tempo ajusté (hauteur de voix préservée).';
  $('run-help').classList.toggle('error-text', !!snap.error);
  const entry = current?.playlist.entries[snap.index];
  if (!current || !entry) {
    $('run-title').textContent = '—';
    $('run-sub').innerHTML = '&nbsp;';
    $('run-cad').textContent = '—';
    $('run-km').textContent = '';
    $('run-time').textContent = '0:00';
  } else {
    const runTime = entry.startTime + snap.position;
    const rate = entry.playbackRate === 1 ? 'tempo original' : `tempo ${entry.playbackRate > 1 ? '+' : ''}${((entry.playbackRate - 1) * 100).toFixed(1)} %`;
    $('run-title').textContent = `${snap.index + 1}. ${entry.song.title}`;
    $('run-sub').textContent = `${entry.song.artist} · ${entry.song.bpm} BPM${entry.multiplier === 2 ? ' ×2' : ''} · ${rate} · ${formatDuration(snap.position)} / ${formatDuration(snap.duration)}`;
    $('run-cad').textContent = String(Math.round(entry.effectiveCadence));
    $('run-time').textContent = formatDuration(runTime);
    $('run-km').textContent = runTime >= current.plan.totalTime ? 'Arrivée !' : `km ${km(distanceAt(current.plan, runTime), 1)} · cible ${cadenceAt(current.plan, runTime)} pas/min`;
  }
  $('run-cad').classList.toggle('silent', !snap.playing);
  if (!seeking) runSeek.value = String(snap.duration > 0 ? Math.round((snap.position / snap.duration) * 1000) : 0);
  for (const row of $('playlist').querySelectorAll<HTMLTableRowElement>('tbody tr')) {
    row.classList.toggle('current', Number(row.dataset.i) === snap.index && (snap.playing || snap.position > 0));
  }
}

runSeek.addEventListener('input', () => (seeking = true));
runSeek.addEventListener('change', () => {
  seeking = false;
  player.seek(Number(runSeek.value) / 1000);
});

const usePlayer = () => service() === 'navidrome';
$('run-toggle').addEventListener('click', () => (usePlayer() ? player.toggle() : companion.toggle()));
$('run-next').addEventListener('click', () => (usePlayer() ? player.next() : companion.next()));
$('run-prev').addEventListener('click', () => (usePlayer() ? player.previous() : companion.previous()));
$('run-reset').addEventListener('click', () => (usePlayer() ? player.jump(0) : companion.reset()));
$('playlist').addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button.row-play');
  if (!btn) return;
  if (usePlayer()) player.jump(Number(btn.dataset.i));
  else companion.jumpTo(Number(btn.dataset.i));
});

function syncCompanionOptions(): void {
  const volume = Number($<HTMLInputElement>('m-volume').value) / 100;
  companion.metronome.setVolume(volume);
  player.metronome.setVolume(volume);
  player.setOverlay($<HTMLInputElement>('m-overlay').checked);
  companion.keepScreenOn = $<HTMLInputElement>('keep-awake').checked;
}
for (const id of ['m-volume', 'm-overlay', 'keep-awake']) $(id).addEventListener('input', syncCompanionOptions);
syncCompanionOptions();

// Barre d'espace = départ / pause (hors champs de saisie).
document.addEventListener('keydown', (ev) => {
  const target = ev.target as HTMLElement;
  if (ev.code !== 'Space' || $('results').hidden || target.closest('input, select, textarea, button, summary')) return;
  ev.preventDefault();
  if (usePlayer()) player.toggle();
  else companion.toggle();
});

// ---------- Exports ----------

const base = () => `runbpm-${slug(state.route?.name ?? 'parcours')}`;
$('export-m3u').addEventListener('click', () => lastExport && download(`${base()}.m3u`, lastExport.m3u, 'audio/x-mpegurl'));
$('export-csv').addEventListener('click', () => lastExport && download(`${base()}.csv`, lastExport.csv, 'text/csv'));
$('export-json').addEventListener('click', () => lastExport && download(`${base()}.json`, lastExport.json, 'application/json'));

// ---------- Démarrage ----------

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
    syncCompanionOptions();
    if (route?.points?.length) setRoute(route);
  } catch {
    /* rien à restaurer */
  }
}

try {
  const saved = localStorage.getItem(SERVICE_KEY);
  if (SERVICES.includes(saved as Service)) $<HTMLSelectElement>('service').value = saved!;
} catch {
  /* préférence indisponible */
}
renderService();
renderLibrarySummary();
libraryView.render();
restorePending();
update();
void spotify.init();
void navidrome.init();
