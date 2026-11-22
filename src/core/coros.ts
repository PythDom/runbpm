import { stepKind, type StepKind, type Workout, type WorkoutBlock, type WorkoutStep } from './workout';

/**
 * Séances partagées par lien COROS (« sharepageeu.coros.com/share/training/program/… » ou
 * « t.coros.com/workout-program?programId=… »). Le détail est public et lisible directement depuis
 * l'application : GET <serveur de la région>/training/program/detail?id=…&region=….
 */

/** Serveurs d'API par région COROS (tels qu'utilisés par le site Training Hub). */
const TEAM_API: Record<number, string> = {
  1: 'https://teamapi.coros.com',
  2: 'https://teamcnapi.coros.com',
  3: 'https://teameuapi.coros.com',
  4: 'https://teamsgapi.coros.com',
};

export interface CorosLink {
  id: string;
  region: number;
}

/** Reconnaît un lien de séance COROS ; undefined si le texte n'en est pas un. */
export function parseCorosLink(text: string): CorosLink | undefined {
  const t = text.trim();
  if (!/^https?:\/\/[^\s]*coros\.com\//i.test(t) || /\s/.test(t)) return undefined;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return undefined;
  }
  const id = url.searchParams.get('programId') ?? url.pathname.match(/\/program\/(\d+)/)?.[1];
  if (!id || !/^\d+$/.test(id)) return undefined;
  const region = Number(url.searchParams.get('region') ?? url.pathname.match(/region-(\d+)/)?.[1] ?? 1);
  return { id, region: TEAM_API[region] ? region : 1 };
}

export function corosDetailUrl(link: CorosLink): string {
  return `${TEAM_API[link.region] ?? TEAM_API[1]}/training/program/detail?id=${encodeURIComponent(link.id)}&region=${link.region}&supportRestExercise=1`;
}

interface CorosExercise {
  id: string;
  groupId?: string;
  isGroup?: boolean;
  sets?: number;
  name?: string;
  exerciseType?: number;
  targetType?: number;
  targetValue?: number;
  intensityType?: number;
  intensityValue?: number;
  intensityValueExtend?: number;
  intensityDisplayUnit?: number;
  restType?: number;
  restValue?: number;
  sortNo?: number;
}

interface CorosProgram {
  name?: string;
  duration?: number;
  distance?: number;
  overview?: string;
  exercises?: CorosExercise[];
}

// Codes COROS : cibles 2 = durée (s), 5 = distance (cm) ; intensités 3 = allure, 8 = allure ajustée ;
// types d'exercice 1 = échauffement, 2 = entraînement, 3 = retour au calme, 4 = récupération ;
// repos après un exercice : 1 = durée (s), 4 = distance (cm).
const TARGET_TIME = 2;
const TARGET_DISTANCE = 5;
const KIND_BY_TYPE: Record<number, StepKind> = { 1: 'warmup', 3: 'cooldown', 4: 'recovery' };
const MILE = 1.609344;

function toStep(e: CorosExercise): WorkoutStep | undefined {
  const name = (e.name ?? '').trim() || 'Bloc';
  const step: WorkoutStep = { name, kind: stepKind(name) };
  if (step.kind === 'other' && e.exerciseType && KIND_BY_TYPE[e.exerciseType]) step.kind = KIND_BY_TYPE[e.exerciseType];
  if (e.targetType === TARGET_TIME && (e.targetValue ?? 0) > 0) step.duration = e.targetValue;
  else if (e.targetType === TARGET_DISTANCE && (e.targetValue ?? 0) > 0) step.distance = e.targetValue! / 100;
  else return undefined; // fin manuelle, fréquence cardiaque… : pas de durée exploitable
  if ((e.intensityType === 3 || e.intensityType === 8) && (e.intensityValue ?? 0) > 0) {
    // Allures stockées par kilomètre, ou par mile selon l'unité d'affichage.
    const perKm = (v: number) => (e.intensityDisplayUnit === 2 ? v / MILE : v);
    const a = perKm(e.intensityValue!);
    const b = perKm(e.intensityValueExtend || e.intensityValue!);
    step.paceLow = Math.round(Math.min(a, b));
    step.paceHigh = Math.round(Math.max(a, b));
  }
  return step;
}

/** Repos programmé après un exercice, transformé en bloc de récupération. */
function restStep(e: CorosExercise): WorkoutStep | undefined {
  if (e.restType === 1 && (e.restValue ?? 0) > 0) return { name: 'Récupération', kind: 'recovery', duration: e.restValue };
  if (e.restType === 4 && (e.restValue ?? 0) > 0) return { name: 'Récupération', kind: 'recovery', distance: e.restValue! / 100 };
  return undefined;
}

/** Convertit le détail d'une séance COROS en séance RunBPM. */
export function corosToWorkout(program: CorosProgram): Workout {
  const all = [...(program.exercises ?? [])].sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0));
  const isTop = (e: CorosExercise) => !e.groupId || e.groupId === '0';
  const stepsOf = (e: CorosExercise): WorkoutStep[] => {
    const s = toStep(e);
    const r = restStep(e);
    return [s, r].filter((x): x is WorkoutStep => !!x);
  };
  const blocks: WorkoutBlock[] = [];
  for (const e of all.filter(isTop)) {
    if (e.isGroup) {
      const steps = all.filter((c) => c.groupId === e.id).flatMap(stepsOf);
      if (steps.length) blocks.push({ repeat: Math.max(1, e.sets ?? 1), steps });
    } else {
      const steps = stepsOf(e);
      if (steps.length) blocks.push({ repeat: Math.max(1, e.sets ?? 1), steps });
    }
  }
  if (!blocks.length) throw new Error('Cette séance COROS ne contient aucun bloc avec une durée ou une distance.');
  return {
    title: program.name?.trim() || 'Séance COROS',
    blocks,
    totalDuration: program.duration || undefined,
    totalDistance: program.distance ? program.distance / 100 : undefined,
  };
}

/** Télécharge et convertit une séance partagée par lien COROS. */
export async function fetchCorosWorkout(link: CorosLink, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Workout> {
  let res: Response;
  try {
    res = await fetchImpl(corosDetailUrl(link));
  } catch {
    throw new Error('COROS injoignable : vérifiez la connexion.');
  }
  const body = (await res.json().catch(() => undefined)) as { result?: string; message?: string; data?: CorosProgram } | undefined;
  if (!res.ok || !body?.data || (body.result && body.result !== '0000')) {
    throw new Error(`Séance COROS introuvable (${body?.message ?? res.status}). Le lien est-il public ?`);
  }
  return corosToWorkout(body.data);
}
