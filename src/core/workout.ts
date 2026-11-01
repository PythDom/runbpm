import type { PlannedSection, RunPlan } from './pacing';

/**
 * Séances d'entraînement fractionnées (texte copié depuis COROS, Garmin…), en alternative au
 * parcours : une suite de blocs (échauffement, efforts, récupérations répétés, retour au calme),
 * chacun avec une durée ou une distance et une allure. Chaque bloc devient une section du plan de
 * course, avec la cadence correspondant à son allure.
 */

export type StepKind = 'warmup' | 'cooldown' | 'fast' | 'recovery' | 'walk' | 'easy' | 'other';

export interface WorkoutStep {
  name: string;
  kind: StepKind;
  /** Durée en secondes (bloc au temps). */
  duration?: number;
  /** Distance en mètres (bloc à la distance). */
  distance?: number;
  /** Plage d'allure indiquée, en s/km (la plus rapide d'abord). */
  paceLow?: number;
  paceHigh?: number;
  /** Allure retenue, en s/km, si elle a été saisie à la main. */
  paceOverride?: number;
}

export interface WorkoutBlock {
  repeat: number;
  steps: WorkoutStep[];
}

export interface Workout {
  title: string;
  blocks: WorkoutBlock[];
  /** Durée et distance totales annoncées par l'application d'origine, si présentes. */
  totalDuration?: number;
  totalDistance?: number;
}

/** Bloc à jouer, une fois les répétitions déroulées. */
export interface ResolvedStep {
  step: WorkoutStep;
  label: string;
  /** Allure retenue (s/km) et sa provenance. */
  pace: number;
  paceSource: 'plage' | 'estimée' | 'saisie';
  duration: number;
  distance: number;
}

// ---------- Lecture du texte ----------

const PACE_TOKEN = String.raw`(\d{1,2})\s*[':’′]\s*(\d{2})\s*(?:''|"|’’|″|”)?`;
const PACE_LINE = new RegExp(String.raw`^(?:pace|allure|rythme)\s*[|:]?\s*${PACE_TOKEN}(?:\s*[-–à]\s*${PACE_TOKEN})?`, 'i');
const DURATION_LINE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const MINUTES_LINE = /^(\d+(?:[.,]\d+)?)\s*(?:min|mn|')$/i;
const SECONDS_LINE = /^(\d+)\s*(?:s|sec|")$/i;
const DISTANCE_LINE = /^(\d+(?:[.,]\d+)?)\s*(km|m)$/i;
const REPEAT_LINE = /^(?:repeat|répéter|repeter|répétez|répétition)s?\s*(\d+)\s*(?:times?|fois|x)?\b/i;
const SUMMARY_LINE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(\d+(?:[.,]\d+)?)\s*km\b/i;

const num = (s: string) => Number.parseFloat(s.replace(',', '.'));

function clock(text: string): number {
  const p = text.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

export function stepKind(name: string): StepKind {
  const n = name.toLowerCase();
  if (/warm|échauf|echauf|chauffe/.test(n)) return 'warmup';
  if (/cool|calme|retour/.test(n)) return 'cooldown';
  if (/marche|walk|hike/.test(n)) return 'walk';
  if (/rest|récup|recup|repos|lent|slow|jog|trot|relâch|relach/.test(n)) return 'recovery';
  if (/\bef\b|endurance|easy|footing|aisance/.test(n)) return 'easy';
  if (/rapide|fast|sprint|vite|vma|interval|training|effort|tempo|seuil|threshold|race|course|côte|cote|hill|accél|accel|stride|run\b/.test(n)) return 'fast';
  return 'other';
}

interface Item {
  repeat?: number;
  step?: WorkoutStep;
}

/** Lit une séance copiée-collée. Lève une erreur si aucun bloc n'est reconnu. */
export function parseWorkout(text: string): Workout {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const items: Item[] = [];
  let title = '';
  let totalDuration: number | undefined;
  let totalDistance: number | undefined;
  let pending: string | undefined;
  let current: WorkoutStep | undefined;

  const addStep = (fields: Partial<WorkoutStep>) => {
    const name = pending ?? 'Bloc';
    current = { name, kind: stepKind(name), ...fields };
    items.push({ step: current });
    pending = undefined;
  };

  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(SUMMARY_LINE))) {
      totalDuration = clock(m[1]);
      totalDistance = num(m[2]) * 1000;
    } else if ((m = line.match(PACE_LINE))) {
      if (!current) continue;
      const a = Number(m[1]) * 60 + Number(m[2]);
      const b = m[3] ? Number(m[3]) * 60 + Number(m[4]) : a;
      current.paceLow = Math.min(a, b);
      current.paceHigh = Math.max(a, b);
    } else if ((m = line.match(REPEAT_LINE))) {
      items.push({ repeat: Math.max(1, Number(m[1])) });
      pending = undefined;
      current = undefined;
    } else if ((m = line.match(DURATION_LINE))) {
      addStep({ duration: m[3] !== undefined ? clock(line) : Number(m[1]) * 60 + Number(m[2]) });
    } else if ((m = line.match(MINUTES_LINE))) {
      addStep({ duration: Math.round(num(m[1]) * 60) });
    } else if ((m = line.match(SECONDS_LINE))) {
      addStep({ duration: Number(m[1]) });
    } else if ((m = line.match(DISTANCE_LINE))) {
      addStep({ distance: num(m[1]) * (m[2].toLowerCase() === 'km' ? 1000 : 1) });
    } else {
      if (!title) title = line;
      pending = line;
    }
  }

  if (!items.some((i) => i.step)) {
    throw new Error('Aucun bloc reconnu : il faut au moins une durée (ex. 04:00) ou une distance (ex. 1.00 km) par bloc.');
  }
  const workout: Workout = { title: title || 'Séance', blocks: [], totalDuration, totalDistance };
  workout.blocks = groupBlocks(items, workout);
  return workout;
}

/**
 * Regroupe les blocs répétés. Une répétition englobe les blocs qui la suivent tant qu'ils sont des
 * efforts ou des récupérations ; un échauffement, un retour au calme ou de l'endurance la termine.
 * Si la durée totale annoncée départage mieux un autre découpage, c'est lui qui est retenu.
 */
function groupBlocks(items: Item[], workout: Workout): WorkoutBlock[] {
  const repeats = items.map((it, i) => (it.repeat ? i : -1)).filter((i) => i >= 0);
  const stepsAfter = (i: number) => {
    let n = 0;
    for (let j = i + 1; j < items.length && items[j].step; j++) n++;
    return n;
  };
  const heuristic = repeats.map((i) => {
    let k = 0;
    for (let j = i + 1; j < items.length && items[j].step; j++) {
      const kind = items[j].step!.kind;
      if (k > 0 && (kind === 'warmup' || kind === 'cooldown' || kind === 'easy')) break;
      k++;
    }
    return Math.max(1, Math.min(k, stepsAfter(i)));
  });

  const build = (sizes: number[]): WorkoutBlock[] => {
    const blocks: WorkoutBlock[] = [];
    let r = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.repeat) {
        const k = Math.min(sizes[r++] ?? 1, stepsAfter(i));
        const steps = items.slice(i + 1, i + 1 + k).map((x) => x.step!);
        if (steps.length) blocks.push({ repeat: it.repeat, steps });
        i += k;
      } else if (it.step) {
        blocks.push({ repeat: 1, steps: [it.step] });
      }
    }
    return blocks;
  };

  let best = build(heuristic);
  if (workout.totalDuration && repeats.length > 0 && repeats.length <= 3) {
    const target = workout.totalDuration;
    const err = (sizes: number[]) => Math.abs(totalTime({ ...workout, blocks: build(sizes) }) - target) / target;
    let bestErr = err(heuristic);
    if (bestErr > 0.02) {
      // Essaie les autres découpages (peu nombreux) et garde celui qui colle à la durée annoncée.
      const options = repeats.map((i) => Array.from({ length: stepsAfter(i) }, (_, k) => k + 1));
      const combos = options.reduce<number[][]>((acc, opts) => acc.flatMap((a) => opts.map((o) => [...a, o])), [[]]);
      for (const sizes of combos) {
        const e = err(sizes);
        if (e < bestErr - 1e-9) {
          bestErr = e;
          best = build(sizes);
        }
      }
    }
  }
  return best;
}

// ---------- Allures, durées et plan ----------

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rangeMid = (s: WorkoutStep) => (s.paceLow !== undefined && s.paceHigh !== undefined ? (s.paceLow + s.paceHigh) / 2 : undefined);

/** Allure de marche retenue (s/km) et cadence de marche (pas/min). */
export const WALK_PACE = 600;
export const WALK_CADENCE = 115;

/**
 * Déroule les répétitions et fixe l'allure de chaque bloc : saisie, sinon milieu de la plage
 * indiquée, sinon estimée d'après les autres blocs (un effort sans allure : nettement plus vite que
 * l'endurance ; une récupération : un peu plus lent).
 */
export function resolveSteps(workout: Workout, fallbackPace = 360): ResolvedStep[] {
  const all = workout.blocks.flatMap((b) => b.steps);
  const known = (kinds: StepKind[]) => all.filter((s) => kinds.includes(s.kind)).map((s) => s.paceOverride ?? rangeMid(s)).filter((p): p is number => p !== undefined);
  const calm = known(['easy', 'warmup', 'cooldown', 'recovery', 'other']);
  const anyKnown = known(['easy', 'warmup', 'cooldown', 'recovery', 'other', 'fast']);
  const easyRef = calm.length ? mean(calm) : anyKnown.length ? mean(anyKnown) : fallbackPace;
  const fastKnown = known(['fast']);
  const recoveryKnown = known(['recovery']);

  const paceOf = (s: WorkoutStep): [number, ResolvedStep['paceSource']] => {
    if (s.paceOverride) return [s.paceOverride, 'saisie'];
    const mid = rangeMid(s);
    if (mid !== undefined) return [mid, 'plage'];
    switch (s.kind) {
      case 'fast':
        return [fastKnown.length ? mean(fastKnown) : easyRef * 0.75, 'estimée'];
      case 'recovery':
        return [recoveryKnown.length ? mean(recoveryKnown) : easyRef * 1.12, 'estimée'];
      case 'walk':
        return [WALK_PACE, 'estimée'];
      default:
        return [easyRef, 'estimée'];
    }
  };

  const out: ResolvedStep[] = [];
  for (const block of workout.blocks) {
    for (let r = 0; r < block.repeat; r++) {
      for (const step of block.steps) {
        const [pace, paceSource] = paceOf(step);
        const speed = 1000 / pace;
        const duration = step.duration ?? (step.distance ?? 0) / speed;
        const distance = step.distance ?? duration * speed;
        out.push({
          step,
          label: block.repeat > 1 ? `${step.name} (${r + 1}/${block.repeat})` : step.name,
          pace: Math.round(pace),
          paceSource,
          duration,
          distance,
        });
      }
    }
  }
  return out;
}

export function totalTime(workout: Workout, fallbackPace?: number): number {
  return resolveSteps(workout, fallbackPace).reduce((a, s) => a + s.duration, 0);
}

/**
 * Plan de course de la séance : une section par bloc, à plat, avec la cadence donnée par
 * `cadenceFor(vitesse en km/h)` (calibrage du coureur ou estimation). Marche : cadence fixe.
 */
export function workoutPlan(workout: Workout, cadenceFor: (speedKmh: number) => number, fallbackPace?: number): RunPlan {
  const steps = resolveSteps(workout, fallbackPace);
  const sections: PlannedSection[] = [];
  let t = 0;
  let d = 0;
  for (const s of steps) {
    const speed = 1000 / s.pace;
    sections.push({
      startDist: d,
      endDist: d + s.distance,
      length: s.distance,
      eleStart: 0,
      eleEnd: 0,
      grade: 0,
      speed,
      pace: s.pace,
      cadence: s.step.kind === 'walk' ? WALK_CADENCE : Math.round(cadenceFor(speed * 3.6)),
      label: s.label,
      startTime: t,
      endTime: t + s.duration,
    });
    t += s.duration;
    d += s.distance;
  }
  const easy = sections.filter((_, i) => ['easy', 'warmup', 'cooldown', 'other'].includes(steps[i].step.kind));
  const ref = easy.length ? easy : sections;
  return {
    sections,
    totalDistance: d,
    totalTime: t,
    baseCadence: Math.round(mean(ref.map((s) => s.cadence))),
  };
}

/** Instants (s) où l'allure change : fins de blocs, utiles pour couper les morceaux. */
export function stepBoundaries(plan: RunPlan): number[] {
  const out: number[] = [];
  for (let i = 0; i < plan.sections.length - 1; i++) {
    if (plan.sections[i].cadence !== plan.sections[i + 1].cadence) out.push(plan.sections[i].endTime);
  }
  return out;
}

/** Allure lisible : 330 → « 5:30 ». */
export function formatPaceShort(secPerKm: number): string {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Allure saisie « 5:30 », « 5'30 », « 5.30 » → s/km. */
export function parsePaceInput(text: string): number | undefined {
  const m = text.trim().match(/^(\d{1,2})\s*[:'’′.,h]\s*(\d{1,2})\s*(?:''|"|’’|″)?$/);
  if (!m) return undefined;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 120 && v <= 1200 && Number(m[2]) < 60 ? v : undefined;
}
