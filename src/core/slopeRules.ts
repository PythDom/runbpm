/**
 * Cadence selon la pente : règle générale « garder une cadence à peu près stable et laisser la
 * longueur de foulée absorber la pente ». La cadence au plat X sert de référence ; chaque tranche
 * de pente l'ajuste (décalage en pas/min) ou impose une cadence (marche active, descente raide).
 *
 * Valeurs par défaut issues des conseils de l'utilisateur ; modifiables par profil coureur.
 */

export interface SlopeRule {
  id: string;
  label: string;
  /** Borne basse de la tranche (%), -Infinity pour la première. */
  from: number;
  /** Borne haute de la tranche (%), Infinity pour la dernière. */
  to: number;
  /** « offset » : X + valeur ; « absolute » : valeur en pas/min quelle que soit X. */
  mode: 'offset' | 'absolute';
  value: number;
  /** Conseil de course affiché pour cette tranche. */
  tip: string;
}

export const DEFAULT_SLOPE_RULES: readonly SlopeRule[] = [
  {
    id: 'down-steep',
    label: 'Descente raide',
    from: -Infinity,
    to: -10,
    mode: 'absolute',
    value: 190,
    tip: 'Pas très rapides, légers et courts. Bras écartés pour l’équilibre, genoux souples ; contrôlez la vitesse par la fréquence, pas en freinant du talon.',
  },
  {
    id: 'down-moderate',
    label: 'Descente modérée',
    from: -10,
    to: -5,
    mode: 'offset',
    value: 7,
    tip: 'Pieds sous le corps, pas devant (ça freine et martèle les quadriceps). Légère inclinaison vers l’avant, perpendiculaire à la pente.',
  },
  {
    id: 'down-gentle',
    label: 'Descente douce',
    from: -5,
    to: -1,
    mode: 'offset',
    value: 3,
    tip: 'Laissez la gravité allonger la foulée : vitesse gratuite, restez relâché.',
  },
  {
    id: 'flat',
    label: 'Plat',
    from: -1,
    to: 1,
    mode: 'offset',
    value: 0,
    tip: 'Cadence de référence.',
  },
  {
    id: 'up-gentle',
    label: 'Montée douce',
    from: 1,
    to: 5,
    mode: 'offset',
    value: 0,
    tip: 'Gardez la cadence, raccourcissez un peu la foulée. Laissez l’allure baisser plutôt que de forcer.',
  },
  {
    id: 'up-moderate',
    label: 'Montée modérée',
    from: 5,
    to: 10,
    mode: 'offset',
    value: 3,
    tip: 'Pas nettement plus courts, appui médio-pied ou avant-pied, légère inclinaison depuis les chevilles, bras actifs.',
  },
  {
    id: 'up-steep',
    label: 'Montée raide',
    from: 10,
    to: 15,
    mode: 'offset',
    value: -7,
    tip: 'Petits pas élastiques. Réglez-vous sur l’effort ou la fréquence cardiaque, pas sur la vitesse.',
  },
  {
    id: 'up-very-steep',
    label: 'Montée très raide',
    from: 15,
    to: Infinity,
    mode: 'absolute',
    value: 120,
    tip: 'Marche active : souvent aussi rapide que la course, et moins coûteuse. Grandes foulées décidées, mains sur les cuisses si besoin, rythme régulier.',
  },
];

/**
 * Tranche de pente correspondant à une pente donnée (en %). Une borne appartient toujours à la
 * tranche la plus raide : +5 % est une montée modérée, −5 % une descente modérée.
 */
export function ruleForGrade(gradePct: number, rules: readonly SlopeRule[] = DEFAULT_SLOPE_RULES): SlopeRule {
  const match =
    gradePct < 0
      ? rules.find((r) => gradePct > r.from && gradePct <= r.to)
      : rules.find((r) => gradePct >= r.from && gradePct < r.to);
  return match ?? rules[rules.length - 1];
}

/** Cadence cible pour une cadence au plat X et une pente données. */
export function cadenceForGrade(base: number, gradePct: number, rules: readonly SlopeRule[] = DEFAULT_SLOPE_RULES): number {
  const r = ruleForGrade(gradePct, rules);
  return r.mode === 'absolute' ? r.value : base + r.value;
}

/** Applique des valeurs personnalisées (par identifiant de tranche) aux règles par défaut. */
export function withValues(values: Record<string, number> | undefined): SlopeRule[] {
  return DEFAULT_SLOPE_RULES.map((r) => ({ ...r, value: Number.isFinite(values?.[r.id]) ? values![r.id] : r.value }));
}

/** Plage de pente lisible, ex. « 5 à 10 % », « > 15 % ». */
export function rangeLabel(r: SlopeRule): string {
  const f = (v: number) => `${v > 0 ? '+' : ''}${v}`;
  if (r.from === -Infinity) return `< ${f(r.to)} %`;
  if (r.to === Infinity) return `≥ ${f(r.from)} %`;
  return `${f(r.from)} à ${f(r.to)} %`;
}
