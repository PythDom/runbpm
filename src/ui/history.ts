import type { Song } from '../core/library';
import { safeStorage } from '../services/spotify';
import { selectionKey } from './selection';

const KEY = 'runbpm.history';
const DAY = 24 * 3600 * 1000;
/** Un morceau écouté pèse de moins en moins pendant ce nombre de jours. */
const FADE_DAYS = 14;
/** Au-delà, il est oublié. */
const KEEP_DAYS = 60;

/**
 * Morceaux écoutés pendant les courses, pour que les playlists suivantes en proposent d'autres.
 * Le poids utilisé par le générateur est figé au démarrage : une playlist ne change pas en pleine
 * course parce que ses propres morceaux viennent d'être écoutés.
 */
export class PlayHistory {
  private readonly store = safeStorage(() => localStorage);
  private readonly played: Record<string, number>;
  /** Clé du morceau → poids de 1 (écouté aujourd'hui) à 0 (il y a 14 jours ou plus). */
  readonly weights = new Map<string, number>();

  constructor(now = Date.now()) {
    let saved: Record<string, number> = {};
    try {
      saved = JSON.parse(this.store.getItem(KEY) ?? '{}') as Record<string, number>;
    } catch {
      /* historique illisible : on repart de zéro */
    }
    this.played = {};
    for (const [key, at] of Object.entries(saved)) {
      const age = (now - at) / DAY;
      if (!(age < KEEP_DAYS)) continue;
      this.played[key] = at;
      const w = 1 - age / FADE_DAYS;
      if (w > 0) this.weights.set(key, Math.min(1, w));
    }
  }

  /** Nombre de morceaux qui comptent encore comme écoutés récemment. */
  get recentCount(): number {
    return this.weights.size;
  }

  record(song: Song, now = Date.now()): void {
    this.played[selectionKey(song)] = now;
    this.store.setItem(KEY, JSON.stringify(this.played));
  }

  clear(): void {
    for (const k of Object.keys(this.played)) delete this.played[k];
    this.weights.clear();
    this.store.removeItem(KEY);
  }
}
