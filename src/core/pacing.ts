import type { Section } from './sections';

/**
 * Plan de course : vitesse, temps de passage et cadence cible pour chaque section.
 *
 * Deux stratégies :
 *  - "pace"   : allure constante, quelle que soit la pente.
 *  - "effort" : effort constant ; on ralentit en montée et on accélère (un peu) en descente,
 *               en conservant la vitesse moyenne demandée sur l'ensemble du parcours.
 *
 * La cadence (pas/min) est d'abord déduite de la vitesse sur le plat, puis corrigée par la pente :
 * en montée, on raccourcit la foulée et on augmente légèrement la fréquence ; en descente,
 * des pas rapides limitent le freinage et les chocs.
 */

export type PacingMode = 'pace' | 'effort';

export interface PlanOptions {
  /** Allure cible moyenne, en secondes par kilomètre. */
  targetPace: number;
  mode: PacingMode;
  /** Cadence du coureur sur le plat à l'allure cible (pas/min). Estimée si absente. */
  baseCadence?: number;
  /** Pas/min ajoutés par % de pente en montée. */
  uphillSensitivity: number;
  /** Pas/min ajoutés par % de pente en descente. */
  downhillSensitivity: number;
  /** Variation de cadence (pas/min) par km/h d'écart à la vitesse cible. */
  speedSensitivity: number;
  /**
   * Applique l'effet de la vitesse section par section (et pas seulement sur le plat) : en
   * « effort constant », la cadence baisse un peu quand on ralentit en montée. Activé par le
   * calibrage, qui mesure cet effet sur les sorties du coureur.
   */
  sectionSpeedEffect?: boolean;
}

export const DEFAULT_PLAN_OPTIONS: Omit<PlanOptions, 'targetPace'> = {
  mode: 'pace',
  uphillSensitivity: 0.6,
  downhillSensitivity: 0.3,
  speedSensitivity: 3,
};

export interface PlannedSection extends Section {
  /** Vitesse en m/s. */
  speed: number;
  /** Allure en s/km. */
  pace: number;
  /** Cadence cible en pas/min. */
  cadence: number;
  startTime: number;
  endTime: number;
}

export interface RunPlan {
  sections: PlannedSection[];
  totalDistance: number;
  totalTime: number;
  baseCadence: number;
}

export const MIN_CADENCE = 140;
export const MAX_CADENCE = 210;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Cadence typique en fonction de la vitesse (km/h). Relation empirique :
 * ~164 pas/min à 8 km/h, ~170 à 10 km/h, ~176 à 12 km/h, ~185 à 15 km/h.
 * À calibrer avec la cadence réelle du coureur dès que possible.
 */
export function estimateCadence(speedKmh: number): number {
  return Math.round(clamp(140 + 3 * speedKmh, 150, 200));
}

/**
 * Coût énergétique de la course en fonction de la pente (Minetti et al., 2002), en J/kg/m.
 * `i` est la pente en fraction, valable environ entre -0.45 et +0.45.
 */
export function minettiCost(i: number): number {
  const g = clamp(i, -0.45, 0.45);
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
}

/**
 * Facteur de vitesse à effort constant par rapport au plat (1 = même vitesse).
 * Le rapport de Minetti brut est trop extrême pour la course réelle (notamment en descente),
 * on l'atténue (racine carrée) et on le borne.
 */
export function effortSpeedFactor(grade: number): number {
  const ratio = minettiCost(0) / minettiCost(grade);
  return clamp(Math.sqrt(ratio), 0.55, 1.15);
}

export function paceToSpeed(secPerKm: number): number {
  return 1000 / secPerKm;
}

export function planRun(sections: Section[], options: Partial<PlanOptions> & { targetPace: number }): RunPlan {
  const opts: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, ...options };
  if (!(opts.targetPace > 0)) throw new Error('Allure cible invalide.');
  const targetSpeed = paceToSpeed(opts.targetPace);
  const totalDistance = sections.reduce((s, x) => s + x.length, 0);

  const factors = sections.map((s) => (opts.mode === 'effort' ? effortSpeedFactor(s.grade) : 1));
  // Vitesse sur le plat telle que le temps total corresponde à l'allure moyenne demandée.
  const weighted = sections.reduce((acc, s, k) => acc + s.length / factors[k], 0);
  const flatSpeed = totalDistance > 0 ? (targetSpeed * weighted) / totalDistance : targetSpeed;

  const targetKmh = targetSpeed * 3.6;
  const flatKmh = flatSpeed * 3.6;
  const baseCadence =
    opts.baseCadence && opts.baseCadence > 0
      ? opts.baseCadence + opts.speedSensitivity * (flatKmh - targetKmh)
      : estimateCadence(flatKmh);

  let t = 0;
  const planned = sections.map((s, k): PlannedSection => {
    const speed = flatSpeed * factors[k];
    const gradePct = s.grade * 100;
    const slopeDelta = gradePct >= 0 ? gradePct * opts.uphillSensitivity : -gradePct * opts.downhillSensitivity;
    const speedDelta = opts.sectionSpeedEffect ? opts.speedSensitivity * (speed - flatSpeed) * 3.6 : 0;
    const cadence = Math.round(clamp(baseCadence + speedDelta + slopeDelta, MIN_CADENCE, MAX_CADENCE));
    const duration = s.length / speed;
    const p: PlannedSection = { ...s, speed, pace: 1000 / speed, cadence, startTime: t, endTime: t + duration };
    t += duration;
    return p;
  });

  return { sections: planned, totalDistance, totalTime: t, baseCadence: Math.round(baseCadence) };
}

/** Cadence cible à un instant donné. */
export function cadenceAt(plan: RunPlan, time: number): number {
  const s = plan.sections.find((x) => time < x.endTime) ?? plan.sections[plan.sections.length - 1];
  return s.cadence;
}

/** Distance parcourue à un instant donné (pour placer les chansons sur le profil). */
export function distanceAt(plan: RunPlan, time: number): number {
  if (time <= 0) return 0;
  for (const s of plan.sections) {
    if (time < s.endTime) return s.startDist + (time - s.startTime) * s.speed;
  }
  return plan.totalDistance;
}

/**
 * Intègre |f(c(t))| sur [t0, t1] : renvoie la moyenne pondérée par le temps d'une fonction
 * de la cadence cible. Au-delà de la fin de course, la dernière cadence est conservée.
 */
export function averageOver(plan: RunPlan, t0: number, t1: number, f: (cadence: number) => number): number {
  if (t1 <= t0) return f(cadenceAt(plan, t0));
  let acc = 0;
  for (const s of plan.sections) {
    const lo = Math.max(t0, s.startTime);
    const hi = Math.min(t1, s.endTime);
    if (hi > lo) acc += (hi - lo) * f(s.cadence);
  }
  if (t1 > plan.totalTime) {
    const last = plan.sections[plan.sections.length - 1];
    acc += (t1 - Math.max(t0, plan.totalTime)) * f(last.cadence);
  }
  return acc / (t1 - t0);
}
