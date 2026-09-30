import type { Playlist } from '../core/playlist';
import { entryIndexAt, findEntryByUri } from '../core/timeline';
import type { PlaybackState } from '../services/spotify';
import { Metronome } from './metronome';

/**
 * Compagnon de course : la musique est jouée par l'application du service de streaming ;
 * RunBPM superpose un métronome au tempo du morceau censé jouer.
 *
 * - Mode chronomètre : le coureur lance la playlist et appuie sur « Départ » en même temps ;
 *   les boutons précédent / suivant permettent de se recaler si un morceau est sauté.
 * - Mode synchronisé (Spotify connecté) : toutes les 4 s, on lit le morceau réellement joué et
 *   sa position ; le métronome suit, y compris les sauts et les pauses.
 */

export type SyncSource = () => Promise<PlaybackState | undefined>;

export type SyncStatus = 'timer' | 'synced' | 'paused' | 'other-track' | 'no-playback' | 'error';

export interface CompanionSnapshot {
  running: boolean;
  /** Temps de course écoulé selon la playlist (secondes). */
  runTime: number;
  /** Morceau censé jouer (-1 : playlist terminée). */
  index: number;
  /** Tempo imposé au métronome (pas/min). */
  cadence?: number;
  sync: SyncStatus;
  /** Le métronome joue réellement (pas en pause Spotify, pas terminé). */
  clicking: boolean;
  screenAwake: boolean;
}

const SYNC_MS = 4000;

export class RunCompanion {
  readonly metronome = new Metronome();
  private playlist?: Playlist;
  private running = false;
  private offset = 0;
  private startedAt = 0;
  private source?: SyncSource;
  private syncStatus: SyncStatus = 'timer';
  private syncing = false;
  private lastSync = 0;
  private remotePaused = false;
  private ticker?: ReturnType<typeof setInterval>;
  private wakeLock?: WakeLockSentinel;
  keepScreenOn = true;

  constructor(private readonly onChange: (s: CompanionSnapshot) => void) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        // Le verrou d'écran est perdu quand la page est masquée : on le reprend au retour.
        if (this.running && document.visibilityState === 'visible') void this.lockScreen();
      });
    }
  }

  setPlaylist(playlist: Playlist | undefined): void {
    this.stop();
    this.playlist = playlist;
    this.offset = 0;
    this.emit();
  }

  /** Active ou désactive la synchronisation avec le service de streaming. */
  setSync(source: SyncSource | undefined): void {
    this.source = source;
    this.syncStatus = source ? 'no-playback' : 'timer';
    this.remotePaused = false;
    if (source && this.running) void this.syncNow();
    this.emit();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.start();
  }

  start(): void {
    if (!this.playlist || this.playlist.entries.length === 0) return;
    this.metronome.unlock();
    if (entryIndexAt(this.playlist, this.offset) < 0) this.offset = 0;
    this.running = true;
    this.startedAt = performance.now();
    this.ticker ??= setInterval(() => this.tick(), 250);
    void this.lockScreen();
    if (this.source) void this.syncNow();
    this.tick();
  }

  pause(): void {
    if (!this.running) return;
    this.offset = this.runTime();
    this.stop();
    this.emit();
  }

  /** Remet le chronomètre à zéro. */
  reset(): void {
    this.stop();
    this.offset = 0;
    this.emit();
  }

  next(): void {
    this.jumpTo(this.currentIndex() + 1);
  }

  previous(): void {
    const i = this.currentIndex();
    const entry = this.playlist?.entries[i];
    // Comme un lecteur : au-delà de 3 s, « précédent » revient au début du morceau.
    if (entry && this.runTime() - entry.startTime > 3) this.jumpTo(i);
    else this.jumpTo(Math.max(0, i - 1));
  }

  jumpTo(index: number): void {
    const entry = this.playlist?.entries[index];
    if (!entry) return;
    this.offset = entry.startTime;
    this.startedAt = performance.now();
    this.tick();
  }

  snapshot(): CompanionSnapshot {
    const index = this.playlist ? entryIndexAt(this.playlist, this.runTime()) : -1;
    const entry = index >= 0 ? this.playlist?.entries[index] : undefined;
    return {
      running: this.running,
      runTime: this.runTime(),
      index,
      cadence: entry?.effectiveCadence,
      sync: this.syncStatus,
      clicking: this.metronome.running,
      screenAwake: this.wakeLock !== undefined && !this.wakeLock.released,
    };
  }

  // ---------- interne ----------

  private runTime(): number {
    // En pause côté Spotify, le chronomètre reste figé sur la dernière position connue.
    return this.running && !this.remotePaused ? this.offset + (performance.now() - this.startedAt) / 1000 : this.offset;
  }

  private currentIndex(): number {
    if (!this.playlist) return -1;
    const i = entryIndexAt(this.playlist, this.runTime());
    return i < 0 ? this.playlist.entries.length - 1 : i;
  }

  private tick(): void {
    if (!this.running || !this.playlist) return;
    const index = entryIndexAt(this.playlist, this.runTime());
    if (index < 0) {
      // Fin de la playlist.
      this.offset = this.playlist.totalDuration;
      this.stop();
      this.emit();
      return;
    }
    const cadence = this.playlist.entries[index].effectiveCadence;
    if (this.remotePaused) this.metronome.stop();
    else if (this.metronome.running) this.metronome.setBpm(cadence);
    else this.metronome.start(cadence);
    if (this.source && performance.now() - this.lastSync >= SYNC_MS) void this.syncNow();
    this.emit();
  }

  private async syncNow(): Promise<void> {
    if (!this.source || this.syncing || !this.playlist) return;
    this.syncing = true;
    this.lastSync = performance.now();
    try {
      const state = await this.source();
      if (!this.running) return;
      if (!state || !state.uri) {
        this.syncStatus = 'no-playback';
        return;
      }
      const index = findEntryByUri(this.playlist, state.uri, this.currentIndex());
      if (index < 0) {
        // Morceau hors playlist : on garde le chronomètre.
        this.syncStatus = 'other-track';
        this.remotePaused = false;
        return;
      }
      this.remotePaused = state.paused;
      this.syncStatus = state.paused ? 'paused' : 'synced';
      this.offset = this.playlist.entries[index].startTime + state.positionMs / 1000;
      this.startedAt = performance.now();
      if (state.paused) this.metronome.stop();
    } catch {
      this.syncStatus = 'error';
    } finally {
      this.syncing = false;
      this.tick();
    }
  }

  private stop(): void {
    this.running = false;
    this.remotePaused = false;
    this.metronome.stop();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = undefined;
  }

  private async lockScreen(): Promise<void> {
    if (!this.keepScreenOn || !('wakeLock' in navigator)) return;
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.emit();
    } catch {
      /* refusé (économie d'énergie, onglet masqué) */
    }
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }
}
