import type { PlaylistEntry } from '../core/playlist';
import { Metronome } from './metronome';

/**
 * Lecteur interne : lit les morceaux diffusés par le serveur (Navidrome / Subsonic) avec la
 * vitesse de lecture conseillée (playbackRate), en conservant la hauteur tonale (preservesPitch).
 * Un métronome peut être superposé à la musique.
 */

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
}

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
      clicking: this.metronome.running,
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

  private syncMetronome(): void {
    const t = this.tracks[this.index];
    if (this.playing && this.overlay && t) {
      if (this.metronome.running) this.metronome.setBpm(t.entry.effectiveCadence);
      else this.metronome.start(t.entry.effectiveCadence);
    } else {
      this.metronome.stop();
    }
  }

  private stop(): void {
    this.audio.pause();
    this.metronome.stop();
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
