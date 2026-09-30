import { trackBeats } from '../core/beats';
import { mixToMono } from '../core/bpm';
import type { PlaylistEntry } from '../core/playlist';
import { Metronome } from './metronome';

/**
 * Lecteur interne : lit les morceaux diffusés par le serveur (Navidrome / Subsonic) avec la
 * vitesse de lecture conseillée (playbackRate), en conservant la hauteur tonale (preservesPitch).
 * Un métronome peut être superposé à la musique. Il est calé sur les temps réels du morceau :
 * le fichier est décodé et ses temps repérés (suivi des temps), puis chaque clic est planifié
 * sur un temps, d'après la position de lecture et la vitesse ajustée. Tant que le repérage n'est
 * pas prêt (ou s'il échoue), le métronome bat librement au tempo du morceau.
 */

/** État du calage du métronome sur les temps du morceau. */
export type BeatSync = 'calé' | 'analyse' | 'libre';

export interface PlayerTrack {
  entry: PlaylistEntry;
  /** URL du flux audio. */
  url: string;
}

export interface PlayerSnapshot {
  index: number;
  playing: boolean;
  /** Position dans le morceau, en secondes réelles (après ajustement du tempo). */
  position: number;
  /** Durée du morceau, en secondes réelles. */
  duration: number;
  error?: string;
  clicking: boolean;
  beatSync: BeatSync;
}

/** Nombre de grilles de temps gardées en mémoire (morceau courant, suivant, précédents). */
const GRID_CACHE = 12;

type AudioWithPitch = HTMLAudioElement & { preservesPitch?: boolean; mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };

export class RunPlayer {
  readonly metronome = new Metronome();
  private readonly audio: AudioWithPitch = new Audio();
  private tracks: PlayerTrack[] = [];
  private index = 0;
  private playing = false;
  private loadedIndex = -1;
  private error?: string;
  private overlay = false;
  /** Temps repérés par morceau (clé : URL du flux). */
  private readonly grids = new Map<string, number[] | 'pending' | 'failed'>();
  private gridTimer?: ReturnType<typeof setInterval>;
  private gridKey?: string;
  /** Instant de l'horloge audio correspondant à la position 0 du morceau (lissé). */
  private anchor?: number;
  private nextBeat = 0;
  /** Compensation de latence du métronome, en secondes (réglage utilisateur). */
  private offset = 0;

  constructor(private readonly onChange: (s: PlayerSnapshot) => void) {
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
    this.audio.addEventListener('ended', () => this.advance(1, true));
    this.audio.addEventListener('timeupdate', () => this.emit());
    this.audio.addEventListener('loadedmetadata', () => this.emit());
    this.audio.addEventListener('error', () => {
      if (this.loadedIndex < 0 || !this.audio.getAttribute('src')) return;
      const t = this.tracks[this.loadedIndex];
      this.error = `Lecture impossible de « ${t?.entry.song.title ?? ''} » (format non pris en charge par le navigateur ?). Morceau suivant.`;
      this.advance(1, this.playing);
    });
    this.setupMediaSession();
  }

  get length(): number {
    return this.tracks.length;
  }

  /** Décalage des clics en millisecondes (positif : plus tard), pour compenser la latence audio. */
  setOffset(ms: number): void {
    this.offset = (Number.isFinite(ms) ? ms : 0) / 1000;
    this.anchor = undefined; // replanifie avec le nouveau décalage
  }

  /** Superpose (ou non) le métronome à la musique. */
  setOverlay(on: boolean): void {
    this.overlay = on;
    this.syncMetronome();
    this.emit();
  }

  /** Charge une nouvelle playlist ; la lecture est arrêtée et revient au début. */
  load(tracks: PlayerTrack[]): void {
    this.stop();
    this.tracks = tracks;
    this.index = 0;
    this.loadedIndex = -1;
    this.error = undefined;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.emit();
  }

  toggle(): void {
    this.error = undefined;
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    // Débloque l'audio pendant le geste utilisateur (exigence des navigateurs mobiles).
    this.metronome.unlock();
    const t = this.tracks[this.index];
    if (!t) return;
    this.ensureLoaded();
    this.audio.playbackRate = t.entry.playbackRate;
    this.audio.defaultPlaybackRate = t.entry.playbackRate;
    this.playing = true;
    this.audio.play().catch((e: Error) => {
      if (e.name === 'AbortError') return;
      this.playing = false;
      this.error = `Lecture refusée par le navigateur : ${e.message}`;
      this.stop();
      this.emit();
    });
    this.syncMetronome();
    this.updateMediaSession();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.stop();
    this.emit();
  }

  next(): void {
    this.advance(1, this.playing);
  }

  previous(): void {
    if (this.position() > 3) {
      this.seek(0);
      return;
    }
    this.advance(-1, this.playing);
  }

  jump(i: number): void {
    if (!this.tracks[i]) return;
    this.select(i);
    this.error = undefined;
    this.play();
  }

  /** Déplace la lecture dans le morceau courant (fraction entre 0 et 1). */
  seek(fraction: number): void {
    this.ensureLoaded();
    const f = Math.min(1, Math.max(0, fraction));
    if (Number.isFinite(this.audio.duration)) this.audio.currentTime = f * this.audio.duration;
    this.emit();
  }

  snapshot(): PlayerSnapshot {
    return {
      index: this.index,
      playing: this.playing,
      position: this.position(),
      duration: this.duration(),
      error: this.error,
      clicking: this.metronome.running || this.gridTimer !== undefined,
      beatSync: this.beatSync(),
    };
  }

  // ---------- interne ----------

  private rate(): number {
    return this.tracks[this.index]?.entry.playbackRate ?? 1;
  }

  private position(): number {
    return this.loadedIndex === this.index ? this.audio.currentTime / this.rate() : 0;
  }

  private duration(): number {
    const t = this.tracks[this.index];
    if (!t) return 0;
    if (this.loadedIndex === this.index && Number.isFinite(this.audio.duration)) return this.audio.duration / this.rate();
    return t.entry.endTime - t.entry.startTime;
  }

  private select(i: number): void {
    this.stop();
    this.index = i;
  }

  private advance(dir: 1 | -1, keepPlaying: boolean): void {
    const target = this.index + dir;
    if (target < 0) return;
    if (target >= this.tracks.length) {
      // Fin de la playlist.
      this.playing = false;
      this.stop();
      this.emit();
      return;
    }
    this.select(target);
    this.playing = false;
    if (keepPlaying) this.play();
    else this.emit();
  }

  private ensureLoaded(): void {
    const t = this.tracks[this.index];
    if (!t || this.loadedIndex === this.index) return;
    this.audio.src = t.url;
    this.loadedIndex = this.index;
  }

  private beatSync(): BeatSync {
    const t = this.tracks[this.index];
    const g = t ? this.grids.get(t.url) : undefined;
    return Array.isArray(g) ? 'calé' : g === 'pending' ? 'analyse' : 'libre';
  }

  private syncMetronome(): void {
    const t = this.tracks[this.index];
    if (!(this.playing && this.overlay && t)) {
      this.metronome.stop();
      this.stopGrid();
      return;
    }
    const grid = this.grids.get(t.url);
    if (Array.isArray(grid)) {
      // Calé sur les temps : le métronome « libre » s'arrête, la grille prend le relais.
      this.metronome.stop();
      if (this.gridKey !== t.url) {
        this.stopGrid();
        this.gridKey = t.url;
      }
      this.startGrid();
    } else {
      this.stopGrid();
      if (this.metronome.running) this.metronome.setBpm(t.entry.effectiveCadence);
      else this.metronome.start(t.entry.effectiveCadence);
      if (!grid) void this.loadGrid(t);
    }
    // Prépare le morceau suivant pendant l'écoute de celui-ci.
    const next = this.tracks[this.index + 1];
    if (next && !this.grids.has(next.url)) void this.loadGrid(next);
  }

  /** Décode le morceau et repère ses temps. */
  private async loadGrid(t: PlayerTrack): Promise<void> {
    if (this.grids.has(t.url)) return;
    this.grids.set(t.url, 'pending');
    this.emit();
    try {
      const res = await fetch(t.url);
      if (!res.ok) throw new Error(String(res.status));
      const audio = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(await res.arrayBuffer());
      const mono = mixToMono(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)));
      const grid = trackBeats(mono, audio.sampleRate, t.entry.song.bpm);
      this.grids.set(t.url, grid && grid.beats.length > 4 ? grid.beats : 'failed');
    } catch {
      this.grids.set(t.url, 'failed');
    }
    while (this.grids.size > GRID_CACHE) this.grids.delete(this.grids.keys().next().value!);
    if (this.tracks[this.index]?.url === t.url) this.syncMetronome();
    this.emit();
  }

  private startGrid(): void {
    if (this.gridTimer) return;
    this.anchor = undefined;
    this.gridTimer = setInterval(() => this.scheduleGrid(), 50);
    this.scheduleGrid();
  }

  private stopGrid(): void {
    if (this.gridTimer) clearInterval(this.gridTimer);
    this.gridTimer = undefined;
    this.anchor = undefined;
    this.metronome.cancelScheduled();
  }

  /** Planifie les clics des prochains temps d'après la position de lecture. */
  private scheduleGrid(): void {
    const t = this.tracks[this.index];
    const grid = t ? this.grids.get(t.url) : undefined;
    if (!t || !Array.isArray(grid) || this.audio.paused) return;
    const ctx = this.metronome.audioContext;
    const rate = this.audio.playbackRate || 1;
    const position = this.audio.currentTime;
    const measured = ctx.currentTime - position / rate;
    if (this.anchor === undefined || Math.abs(measured - this.anchor) > 0.08) {
      // Départ, déplacement dans le morceau ou changement de vitesse : on repart de la position actuelle.
      this.anchor = measured;
      this.metronome.cancelScheduled();
      this.nextBeat = grid.findIndex((b) => b >= position);
      if (this.nextBeat < 0) this.nextBeat = grid.length;
    } else {
      // La position de lecture est un peu bruitée : lissage de l'ancrage.
      this.anchor += (measured - this.anchor) * 0.05;
    }
    const horizon = ctx.currentTime + (typeof document !== 'undefined' && document.hidden ? 2 : 0.3);
    const perBeat = t.entry.multiplier;
    while (this.nextBeat < grid.length) {
      const b = grid[this.nextBeat];
      const when = this.anchor + b / rate + this.offset;
      if (when > horizon) break;
      this.metronome.clickAt(when);
      // Un pas par demi-temps : clic supplémentaire au milieu de l'intervalle.
      if (perBeat === 2 && this.nextBeat + 1 < grid.length) {
        this.metronome.clickAt(this.anchor + (b + grid[this.nextBeat + 1]) / 2 / rate + this.offset);
      }
      this.nextBeat++;
    }
  }

  private stop(): void {
    this.audio.pause();
    this.metronome.stop();
    this.stopGrid();
  }

  private emit(): void {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    this.onChange(this.snapshot());
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const handlers: [MediaSessionAction, () => void][] = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['nexttrack', () => this.next()],
      ['previoustrack', () => this.previous()],
    ];
    for (const [action, fn] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        /* action non prise en charge */
      }
    }
  }

  private updateMediaSession(): void {
    const t = this.tracks[this.index];
    if (!t || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.entry.song.title,
      artist: t.entry.song.artist,
      album: `RunBPM · ${t.entry.effectiveCadence} pas/min`,
    });
  }
}
