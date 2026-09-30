import type { Song } from './library';
import { averageOver, cadenceAt, type RunPlan } from './pacing';

/**
 * Génération de la playlist.
 *
 * On avance dans le temps de course : à chaque instant t, on choisit le morceau dont le tempo
 * colle le mieux à la cadence cible sur toute la durée où il sera joué (la cadence peut changer
 * en cours de morceau si le parcours passe d'une montée à une descente, par exemple).
 *
 * Un morceau à 88 BPM convient à une cadence de 176 pas/min (un pas par demi-temps) : c'est le
 * mode « demi-tempo ». Optionnellement, le lecteur peut accélérer/ralentir légèrement le morceau
 * (time-stretch) pour tomber pile sur la cadence.
 */

export interface PlaylistOptions {
  /** Écart relatif toléré entre tempo et cadence (0.03 = ±3 %). */
  tolerance: number;
  /** Autorise les morceaux à mi-tempo (BPM × 2 = cadence). */
  allowHalfTime: boolean;
  /** Ajustement de vitesse de lecture maximal (0.04 = ±4 %, 0 = désactivé). */
  maxStretch: number;
  /** Autorise la répétition d'un morceau quand la bibliothèque est épuisée. */
  allowRepeat: boolean;
  /** Graine pour varier les propositions à qualité équivalente. */
  seed: number;
  /**
   * Indique si la vitesse de lecture d'un morceau peut être ajustée. Faux pour les morceaux lus
   * via un service de streaming (Spotify ne permet pas de changer le tempo) : seuls les morceaux
   * naturellement au bon tempo conviennent alors.
   */
  canStretch?: (song: Song) => boolean;
}

export const DEFAULT_PLAYLIST_OPTIONS: PlaylistOptions = {
  tolerance: 0.03,
  allowHalfTime: true,
  maxStretch: 0.04,
  allowRepeat: false,
  seed: 1,
};

export interface PlaylistEntry {
  song: Song;
  startTime: number;
  endTime: number;
  /** Cadence cible moyenne pendant le morceau. */
  targetCadence: number;
  /** 1 = un pas par temps, 2 = un pas par demi-temps. */
  multiplier: 1 | 2;
  /** Vitesse de lecture conseillée (1 = originale). */
  playbackRate: number;
  /** Pas/min imposés par le morceau une fois ajusté. */
  effectiveCadence: number;
  /** Écart relatif moyen entre le morceau et la cadence cible. */
  error: number;
  repeated: boolean;
}

export interface Playlist {
  entries: PlaylistEntry[];
  totalDuration: number;
  /** Part du temps de course où l'écart est dans la tolérance. */
  matchRatio: number;
  warnings: string[];
}

/** Petit générateur pseudo-aléatoire déterministe (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate {
  song: Song;
  multiplier: 1 | 2;
  rate: number;
  duration: number;
  error: number;
  cost: number;
  repeated: boolean;
}

function evaluate(
  plan: RunPlan,
  t: number,
  song: Song,
  multiplier: 1 | 2,
  opts: PlaylistOptions,
): Omit<Candidate, 'cost' | 'repeated'> {
  const natural = song.bpm * multiplier;
  // Premier passage : cadence moyenne sur la durée naturelle du morceau.
  const avg = averageOver(plan, t, t + song.duration, (c) => c);
  const maxStretch = opts.canStretch && !opts.canStretch(song) ? 0 : opts.maxStretch;
  const rate = maxStretch > 0 ? Math.min(1 + maxStretch, Math.max(1 - maxStretch, avg / natural)) : 1;
  const duration = song.duration / rate;
  const effective = natural * rate;
  const error = averageOver(plan, t, t + duration, (c) => Math.abs(effective - c) / c);
  return { song, multiplier, rate, duration, error };
}

export function generatePlaylist(plan: RunPlan, library: Song[], options: Partial<PlaylistOptions> = {}): Playlist {
  const opts: PlaylistOptions = { ...DEFAULT_PLAYLIST_OPTIONS, ...options };
  const warnings: string[] = [];
  const entries: PlaylistEntry[] = [];
  if (library.length === 0) {
    return { entries, totalDuration: 0, matchRatio: 0, warnings: ['La bibliothèque musicale est vide.'] };
  }
  const random = rng(opts.seed);
  const useCount = new Map<string, number>();
  let exhaustedWarned = false;
  let t = 0;
  let guard = 0;

  while (t < plan.totalTime - 1 && guard++ < 1000) {
    const candidates: Candidate[] = [];
    for (const song of library) {
      const used = useCount.get(song.id) ?? 0;
      if (used > 0 && !opts.allowRepeat) continue;
      const multipliers: (1 | 2)[] = opts.allowHalfTime ? [1, 2] : [1];
      for (const m of multipliers) {
        const ev = evaluate(plan, t, song, m, opts);
        // Coût : écart de tempo, pénalité légère sur le time-stretch et le mi-tempo,
        // forte pénalité sur les répétitions, bruit pour varier entre morceaux équivalents.
        const cost =
          ev.error +
          Math.abs(ev.rate - 1) * 0.5 +
          (m === 2 ? 0.002 : 0) +
          used * 0.05 +
          random() * opts.tolerance * 0.3;
        candidates.push({ ...ev, cost, repeated: used > 0 });
      }
    }

    if (candidates.length === 0) {
      if (!exhaustedWarned) {
        warnings.push(
          `Bibliothèque épuisée après ${entries.length} morceau(x) : ajoutez des morceaux ou autorisez les répétitions.`,
        );
        exhaustedWarned = true;
      }
      break;
    }

    candidates.sort((a, b) => a.cost - b.cost);
    const best = candidates[0];
    const target = averageOver(plan, t, t + best.duration, (c) => c);
    entries.push({
      song: best.song,
      startTime: t,
      endTime: t + best.duration,
      targetCadence: Math.round(target),
      multiplier: best.multiplier,
      playbackRate: Math.round(best.rate * 1000) / 1000,
      effectiveCadence: Math.round(best.song.bpm * best.multiplier * best.rate * 10) / 10,
      error: best.error,
      repeated: best.repeated,
    });
    useCount.set(best.song.id, (useCount.get(best.song.id) ?? 0) + 1);
    t += best.duration;
  }

  // Qualité : part du temps de course (jusqu'à l'arrivée) où l'écart instantané est toléré.
  let matched = 0;
  const step = 5;
  let samples = 0;
  for (let time = 0; time < plan.totalTime; time += step) {
    samples++;
    const e = entries.find((x) => time >= x.startTime && time < x.endTime);
    if (!e) continue;
    const c = cadenceAt(plan, time);
    if (Math.abs(e.effectiveCadence - c) / c <= opts.tolerance + 1e-9) matched++;
  }
  const matchRatio = samples > 0 ? matched / samples : 0;

  const covered = entries.length > 0 ? entries[entries.length - 1].endTime : 0;
  if (covered < plan.totalTime - 1 && !exhaustedWarned) {
    warnings.push('La playlist ne couvre pas toute la durée de la course.');
  }
  const poor = entries.filter((e) => e.error > opts.tolerance);
  if (poor.length > 0) {
    const cadences = [...new Set(poor.map((e) => e.targetCadence))].sort((a, b) => a - b);
    warnings.push(
      `${poor.length} morceau(x) hors tolérance. Il manque des morceaux autour de ${cadences.join(', ')} pas/min` +
        (opts.allowHalfTime ? ` (ou ${cadences.map((c) => Math.round(c / 2)).join(', ')} BPM en mi-tempo).` : '.'),
    );
  }

  return { entries, totalDuration: covered, matchRatio, warnings };
}
