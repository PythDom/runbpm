import type { PlaylistEntry } from '../core/playlist';
import type { PlaybackState } from '../services/spotify';
import { Metronome } from './metronome';

/**
 * Lecteur de la playlist de course.
 *
 * - Morceau associé à un fichier audio : lu avec la vitesse de lecture conseillée
 *   (playbackRate), en conservant la hauteur tonale (preservesPitch).
 * - Morceau disponible sur un service de streaming (Spotify) : lecture pilotée à distance,
 *   sans ajustement de tempo possible (la playlist choisit alors des morceaux au tempo exact).
 * - Sinon : remplacé par un métronome à la cadence du morceau (optionnel), ou ignoré.
 * - Le métronome peut aussi être superposé à la musique pour aider à trouver le rythme.
 */

export type TrackMode = 'audio' | 'spotify' | 'metronome';

export interface PlayerTrack {
  entry: PlaylistEntry;
  file?: File;
  spotifyUri?: string;
}

/** Lecture pilotée à distance (Spotify Connect ou lecteur web Spotify). */
export interface RemotePlayback {
  play(uri: string, positionMs: number): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  state(): Promise<PlaybackState | undefined>;
  /** À appeler pendant un geste utilisateur (déblocage audio sur mobile). */
  activate?(): void;
}

const REMOTE_SYNC_MS = 3000;

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
  /** Chronométrage des morceaux « métronome » et « spotify » (horloge locale). */
  private virtualOffset = 0;
  private virtualStartedAt = 0;
  private remote?: RemotePlayback;
  /** Vrai tant que le service distant est censé jouer un de nos morceaux. */
  private remoteActive = false;
  private remoteDuration?: number;
  private remoteSyncing = false;
  private lastRemoteSync = 0;
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

  /** Active (ou retire) la lecture via un service de streaming. */
  setRemote(remote: RemotePlayback | undefined): void {
    if (remote === this.remote) return;
    if (this.modeOf(this.index) === 'spotify' && this.playing) this.pause();
    this.releaseRemote();
    this.remote = remote;
    this.emit();
  }

  /** Charge une nouvelle playlist ; la lecture est arrêtée et revient au début. */
  load(tracks: PlayerTrack[]): void {
    this.stopAll();
    this.releaseRemote();
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
    if (t.spotifyUri && this.remote) return 'spotify';
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
    this.remote?.activate?.();
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
    const mode = this.modeOf(this.index);
    if (mode === 'metronome' || mode === 'spotify') this.virtualOffset = this.virtualPosition();
    this.playing = false;
    this.stopAll();
    this.releaseRemote();
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
      if (this.modeOf(this.index) === 'spotify' && this.playing) {
        this.remote?.seek(this.virtualOffset * 1000).catch((e: Error) => this.fail(e));
      }
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
    const mode = this.modeOf(this.index);
    if (mode === 'metronome' || mode === 'spotify') return this.virtualPosition();
    return 0;
  }

  private duration(): number {
    const t = this.current();
    if (!t) return 0;
    if (this.modeOf(this.index) === 'audio' && this.loadedIndex === this.index && Number.isFinite(this.audio.duration)) {
      return this.audio.duration / this.rate();
    }
    if (this.modeOf(this.index) === 'spotify' && this.remoteDuration) return this.remoteDuration;
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
    this.remoteDuration = undefined;
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
        this.releaseRemote();
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
    const mode = this.modeOf(this.index);
    // Le service distant ne doit pas continuer à jouer sous un fichier local ou le métronome.
    if (mode !== 'spotify') this.releaseRemote();
    if (mode === 'spotify') {
      this.virtualStartedAt = performance.now();
      this.lastRemoteSync = performance.now();
      this.remoteActive = true;
      const index = this.index;
      this.remote!.play(t.spotifyUri!, this.virtualOffset * 1000).catch((e: Error) => {
        if (index === this.index) this.fail(e);
      });
    } else if (mode === 'audio') {
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
    const mode = this.modeOf(this.index);
    if (this.playing && mode === 'metronome' && this.virtualPosition() >= this.duration()) {
      this.advance(1, true);
      return;
    }
    if (this.playing && mode === 'spotify') {
      // On enchaîne juste avant la fin, pour que Spotify ne lance pas sa propre suite.
      if (this.virtualPosition() >= this.duration() - 0.5) {
        this.advance(1, true);
        return;
      }
      if (performance.now() - this.lastRemoteSync >= REMOTE_SYNC_MS) this.syncRemote();
    }
    this.emit();
  }

  /** Recale l'horloge locale sur la position réelle du service distant. */
  private syncRemote(): void {
    const t = this.current();
    if (!this.remote || !t || this.remoteSyncing) return;
    this.remoteSyncing = true;
    this.lastRemoteSync = performance.now();
    const index = this.index;
    const startedAt = this.virtualStartedAt;
    this.remote
      .state()
      .then((s) => {
        if (!s || index !== this.index || !this.playing || s.uri !== t.spotifyUri) return;
        if (s.durationMs > 0) this.remoteDuration = s.durationMs / 1000;
        const sinceStart = (performance.now() - startedAt) / 1000;
        const midTrack = s.positionMs > 1000 && s.positionMs < s.durationMs - 2000;
        if (s.paused && sinceStart > 4 && midTrack) {
          // Mis en pause depuis l'application Spotify : on suit.
          this.virtualOffset = s.positionMs / 1000;
          this.playing = false;
          this.remoteActive = false;
          this.stopAll();
          this.emit();
          return;
        }
        if (!s.paused) {
          this.virtualOffset = s.positionMs / 1000;
          this.virtualStartedAt = performance.now();
        }
      })
      .catch(() => {
        /* synchronisation facultative : on garde l'horloge locale */
      })
      .finally(() => (this.remoteSyncing = false));
  }

  private fail(e: Error): void {
    this.playing = false;
    this.remoteActive = false;
    this.error = e.message;
    this.stopAll();
    this.emit();
  }

  private releaseRemote(): void {
    if (!this.remoteActive) return;
    this.remoteActive = false;
    this.remote?.pause().catch(() => {
      /* déjà en pause ou appareil indisponible */
    });
  }

  private syncMetronome(): void {
    const t = this.current();
    const mode = this.modeOf(this.index);
    const wanted =
      this.playing && t && (mode === 'metronome' || ((mode === 'audio' || mode === 'spotify') && this.options.metronomeOverlay));
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
