import type { PlaylistEntry } from '../core/playlist';
import { Metronome } from './metronome';

/**
 * Lecteur de la playlist de course.
 *
 * - Morceau associé à un fichier audio : lu avec la vitesse de lecture conseillée
 *   (playbackRate), en conservant la hauteur tonale (preservesPitch).
 * - Morceau sans fichier : remplacé par un métronome à la cadence du morceau (optionnel),
 *   sinon ignoré.
 * - Le métronome peut aussi être superposé à la musique pour aider à trouver le rythme.
 */

export type TrackMode = 'audio' | 'metronome';

export interface PlayerTrack {
  entry: PlaylistEntry;
  file?: File;
}

export interface PlayerOptions {
  metronomeFallback: boolean;
  metronomeOverlay: boolean;
  metronomeVolume: number;
}

export interface PlayerSnapshot {
  index: number;
  playing: boolean;
  mode?: TrackMode;
  /** Position dans le morceau, en secondes réelles (après ajustement du tempo). */
  position: number;
  /** Durée du morceau, en secondes réelles. */
  duration: number;
  error?: string;
}

type AudioWithPitch = HTMLAudioElement & { preservesPitch?: boolean; mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };

export class RunPlayer {
  readonly metronome = new Metronome();
  private readonly audio: AudioWithPitch = new Audio();
  private tracks: PlayerTrack[] = [];
  private index = 0;
  private playing = false;
  private objectUrl?: string;
  private loadedIndex = -1;
  /** Chronométrage des morceaux « métronome » (sans fichier audio). */
  private virtualOffset = 0;
  private virtualStartedAt = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private error?: string;
  private options: PlayerOptions = { metronomeFallback: true, metronomeOverlay: false, metronomeVolume: 0.5 };

  constructor(private readonly onChange: (s: PlayerSnapshot) => void) {
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
    this.audio.addEventListener('ended', () => this.advance(1, true));
    this.audio.addEventListener('timeupdate', () => this.emit());
    this.audio.addEventListener('loadedmetadata', () => this.emit());
    this.audio.addEventListener('error', () => {
      if (this.loadedIndex < 0) return;
      const name = this.tracks[this.loadedIndex]?.file?.name ?? '';
      this.error = `Lecture impossible de « ${name} » (format non pris en charge ?). Morceau suivant.`;
      this.advance(1, this.playing);
    });
    this.setupMediaSession();
  }

  get length(): number {
    return this.tracks.length;
  }

  setOptions(opts: Partial<PlayerOptions>): void {
    this.options = { ...this.options, ...opts };
    this.metronome.setVolume(this.options.metronomeVolume);
    // Si le morceau courant n'est plus jouable (métronome de secours désactivé), on passe au suivant.
    if (this.playing && this.modeOf(this.index) === undefined) this.advance(1, true);
    else this.syncMetronome();
    this.emit();
  }

  /** Charge une nouvelle playlist ; la lecture est arrêtée et revient au début. */
  load(tracks: PlayerTrack[]): void {
    this.stopAll();
    this.tracks = tracks;
    this.index = 0;
    this.loadedIndex = -1;
    this.virtualOffset = 0;
    this.error = undefined;
    this.releaseUrl();
    this.audio.removeAttribute('src');
    this.emit();
  }

  modeOf(i: number): TrackMode | undefined {
    const t = this.tracks[i];
    if (!t) return undefined;
    if (t.file) return 'audio';
    return this.options.metronomeFallback ? 'metronome' : undefined;
  }

  playableCount(): number {
    return this.tracks.filter((_, i) => this.modeOf(i) !== undefined).length;
  }

  toggle(): void {
    this.error = undefined;
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    // Débloque l'audio pendant le geste utilisateur (exigence des navigateurs mobiles).
    this.metronome.unlock();
    if (this.tracks.length === 0) return;
    if (this.modeOf(this.index) === undefined) {
      const next = this.findPlayable(this.index, 1);
      if (next === undefined) {
        this.error = 'Aucun morceau jouable : associez des fichiers audio ou activez le métronome de secours.';
        this.emit();
        return;
      }
      this.select(next);
    }
    this.playing = true;
    this.startCurrent();
  }

  pause(): void {
    if (!this.playing) return;
    if (this.modeOf(this.index) === 'metronome') this.virtualOffset = this.virtualPosition();
    this.playing = false;
    this.stopAll();
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
    this.playing = false;
    this.play();
  }

  /** Déplace la lecture dans le morceau courant (fraction entre 0 et 1). */
  seek(fraction: number): void {
    const f = Math.min(1, Math.max(0, fraction));
    if (this.modeOf(this.index) === 'audio') {
      this.ensureLoaded();
      if (Number.isFinite(this.audio.duration)) this.audio.currentTime = f * this.audio.duration;
    } else {
      this.virtualOffset = f * this.duration();
      this.virtualStartedAt = performance.now();
    }
    this.emit();
  }

  snapshot(): PlayerSnapshot {
    return {
      index: this.index,
      playing: this.playing,
      mode: this.modeOf(this.index),
      position: this.position(),
      duration: this.duration(),
      error: this.error,
    };
  }

  // ---------- interne ----------

  private current(): PlayerTrack | undefined {
    return this.tracks[this.index];
  }

  private rate(): number {
    return this.current()?.entry.playbackRate ?? 1;
  }

  private position(): number {
    if (this.modeOf(this.index) === 'audio' && this.loadedIndex === this.index) return this.audio.currentTime / this.rate();
    if (this.modeOf(this.index) === 'metronome') return this.virtualPosition();
    return 0;
  }

  private duration(): number {
    const t = this.current();
    if (!t) return 0;
    if (this.modeOf(this.index) === 'audio' && this.loadedIndex === this.index && Number.isFinite(this.audio.duration)) {
      return this.audio.duration / this.rate();
    }
    return t.entry.endTime - t.entry.startTime;
  }

  private virtualPosition(): number {
    if (!this.playing) return this.virtualOffset;
    return this.virtualOffset + (performance.now() - this.virtualStartedAt) / 1000;
  }

  private findPlayable(from: number, dir: 1 | -1): number | undefined {
    for (let i = from; i >= 0 && i < this.tracks.length; i += dir) {
      if (this.modeOf(i) !== undefined) return i;
    }
    return undefined;
  }

  private select(i: number): void {
    this.stopAll();
    this.index = i;
    this.virtualOffset = 0;
  }

  private advance(dir: 1 | -1, keepPlaying: boolean): void {
    const target = this.findPlayable(this.index + dir, dir);
    if (target === undefined) {
      if (dir === 1) {
        // Fin de la playlist, ou plus rien de jouable ensuite.
        if (this.index < this.tracks.length - 1) {
          this.error = 'Plus aucun morceau jouable ensuite : associez des fichiers audio ou activez le métronome de secours.';
        }
        this.playing = false;
        this.stopAll();
        this.emit();
      }
      return;
    }
    this.select(target);
    this.playing = false;
    if (keepPlaying) this.play();
    else this.emit();
  }

  private ensureLoaded(): void {
    const t = this.current();
    if (!t?.file || this.loadedIndex === this.index) return;
    this.releaseUrl();
    this.objectUrl = URL.createObjectURL(t.file);
    this.audio.src = this.objectUrl;
    this.loadedIndex = this.index;
  }

  private startCurrent(): void {
    const t = this.current();
    if (!t) return;
    if (this.modeOf(this.index) === 'audio') {
      this.ensureLoaded();
      this.audio.playbackRate = t.entry.playbackRate;
      this.audio.defaultPlaybackRate = t.entry.playbackRate;
      this.audio.play().catch((e: Error) => {
        if (e.name === 'AbortError') return;
        this.playing = false;
        this.error = `Lecture refusée par le navigateur : ${e.message}`;
        this.stopAll();
        this.emit();
      });
    } else {
      this.virtualStartedAt = performance.now();
    }
    this.syncMetronome();
    this.updateMediaSession();
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 250);
    this.emit();
  }

  private tick(): void {
    if (this.playing && this.modeOf(this.index) === 'metronome' && this.virtualPosition() >= this.duration()) {
      this.advance(1, true);
      return;
    }
    this.emit();
  }

  private syncMetronome(): void {
    const t = this.current();
    const mode = this.modeOf(this.index);
    const wanted = this.playing && t && (mode === 'metronome' || (mode === 'audio' && this.options.metronomeOverlay));
    if (wanted) this.metronome.start(t.entry.effectiveCadence);
    else this.metronome.stop();
  }

  private stopAll(): void {
    this.audio.pause();
    this.metronome.stop();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private releaseUrl(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.loadedIndex = -1;
  }

  private emit(): void {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    this.onChange(this.snapshot());
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, () => void][] = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['nexttrack', () => this.next()],
      ['previoustrack', () => this.previous()],
    ];
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* action non prise en charge */
      }
    }
  }

  private updateMediaSession(): void {
    const t = this.current();
    if (!t || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.entry.song.title,
      artist: t.entry.song.artist,
      album: `RunBPM · ${t.entry.effectiveCadence} pas/min`,
    });
  }
}
