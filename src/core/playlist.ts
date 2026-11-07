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
  /**
   * Instants (s) où les morceaux peuvent être coupés (changements d'allure d'une séance
   * fractionnée). Seul le lecteur intégré sait couper un morceau ; ailleurs, laisser vide.
   */
  cutAt?: number[];
  /**
   * Morceaux écoutés récemment : clé du morceau → poids de 0 à 1 (1 = écouté aujourd'hui). Ils sont
   * moins souvent choisis, pour varier d'une sortie à l'autre.
   */
  recent?: ReadonlyMap<string, number>;
  /** Clé d'un morceau pour `recent` (par défaut son identifiant). */
  keyOf?: (song: Song) => string;
}

/** En deçà, un bout de bloc restant n'a pas son propre morceau : le suivant déborde dessus. */
const MIN_CUT_WINDOW = 15;

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
  /** Morceau arrêté avant sa fin (changement de bloc). */
  cut?: boolean;
  /** Position de départ dans le morceau, en secondes du morceau (morceau coupé court). */
  songStart?: number;
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
  cut: boolean;
}

function evaluate(
  plan: RunPlan,
  t: number,
  song: Song,
  multiplier: 1 | 2,
  opts: PlaylistOptions,
  limit = Infinity,
): Omit<Candidate, 'cost' | 'repeated'> {
  const natural = song.bpm * multiplier;
  // Premier passage : cadence moyenne sur la durée naturelle du morceau (ou jusqu'à la coupure).
  const avg = averageOver(plan, t, Math.min(t + song.duration, limit), (c) => c);
  const maxStretch = opts.canStretch && !opts.canStretch(song) ? 0 : opts.maxStretch;
  const rate = maxStretch > 0 ? Math.min(1 + maxStretch, Math.max(1 - maxStretch, avg / natural)) : 1;
  const full = song.duration / rate;
  const cut = t + full > limit;
  const duration = cut ? limit - t : full;
  const effective = natural * rate;
  const error = averageOver(plan, t, t + duration, (c) => Math.abs(effective - c) / c);
  return { song, multiplier, rate, duration, error, cut };
}

/**
 * Départ d'un morceau coupé court : au quart du morceau (après l'introduction, souvent plus calme)
 * quand il en reste assez, sinon au début.
 */
function songStartFor(songDuration: number, played: number): number {
  if (played >= songDuration * 0.6) return 0;
  return Math.round(Math.min(songDuration * 0.25, songDuration - played));
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

  const cuts = [...(opts.cutAt ?? [])].sort((a, b) => a - b);
  while (t < plan.totalTime - 1 && guard++ < 1000) {
    // Prochaine coupure possible, assez loin pour mériter son propre morceau.
    const limit = cuts.find((b) => b >= t + MIN_CUT_WINDOW) ?? Infinity;
    const candidates: Candidate[] = [];
    for (const song of library) {
      const used = useCount.get(song.id) ?? 0;
      if (used > 0 && !opts.allowRepeat) continue;
      const multipliers: (1 | 2)[] = opts.allowHalfTime ? [1, 2] : [1];
      for (const m of multipliers) {
        const ev = evaluate(plan, t, song, m, opts, limit);
        // Un morceau qui s'arrête juste avant la coupure laisserait un bout de bloc trop court.
        const gap = limit - (t + ev.duration);
        const shortGap = !ev.cut && gap > 0 && gap < MIN_CUT_WINDOW * 2 ? 0.03 : 0;
        // Coût : un morceau dans la tolérance vaut presque n'importe quel autre dans la tolérance
        // (tirage au sort entre eux, pour la variété) ; au-delà, l'écart compte pleinement.
        // Pénalités légères : ajustement de vitesse, mi-tempo, écoute récente ; forte : répétition.
        const fit = ev.error <= opts.tolerance ? ev.error * 0.25 : ev.error;
        const recent = opts.recent?.get(opts.keyOf ? opts.keyOf(song) : song.id) ?? 0;
        const cost =
          fit +
          Math.abs(ev.rate - 1) * 0.15 +
          (m === 2 ? 0.002 : 0) +
          used * 0.05 +
          recent * opts.tolerance * 1.5 +
          random() * opts.tolerance +
          shortGap;
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
      ...(best.cut ? { cut: true, songStart: songStartFor(best.song.duration, best.duration * best.rate) } : {}),
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
