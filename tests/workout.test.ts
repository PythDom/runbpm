import { describe, expect, it } from 'vitest';
import { estimateCadence } from '../src/core/pacing';
import { parsePaceInput, parseWorkout, resolveSteps, stepBoundaries, totalTime, workoutPlan } from '../src/core/workout';

const FRACTIONNE = `4x 4min/3min
44:00 8.31km 131TL

fractionné 4min/3min
Warm Up

1.00 km
Pace | 5'30''-6'30'' min/km
Repeat 4 Times
Training

04:00
Pace | 4'30''-5'10'' min/km
Rest

03:00
Pace | 5'00''-6'00'' min/km
Cool Down

10:00
Pace | 5'00''-6'00'' min/km`;

const BRULURE = `42KM-S6-3-Endurance de Force : "Brûlure 🔥"
47:30 4.69km 42TL

Séance d'endurance de force où tu vas devoir répéter 5 efforts de 30 secondes à très haute intensité séparés par 3' de récupération … View more
EF

20:00
Pace | 6'09''-6'39'' min/km
Repeat 5 Times
Rapide

00:30
Lent

03:00
EF

10:00
Pace | 6'09''-6'39'' min/km`;

describe('séances d’entraînement', () => {
  it('lit un fractionné COROS : répétition, plages d’allure, totaux', () => {
    const w = parseWorkout(FRACTIONNE);
    expect(w.title).toBe('4x 4min/3min');
    expect(w.totalDuration).toBe(44 * 60);
    expect(w.totalDistance).toBeCloseTo(8310);
    expect(w.blocks.map((b) => [b.repeat, b.steps.map((s) => `${s.name}:${s.kind}`).join('+')])).toEqual([
      [1, 'Warm Up:warmup'],
      [4, 'Training:fast+Rest:recovery'],
      [1, 'Cool Down:cooldown'],
    ]);
    const steps = resolveSteps(w);
    expect(steps).toHaveLength(10);
    expect(steps[0]).toMatchObject({ pace: 360, distance: 1000, duration: 360, paceSource: 'plage' });
    expect(steps[1]).toMatchObject({ label: 'Training (1/4)', pace: 290, duration: 240 });
    expect(Math.round(totalTime(w))).toBe(44 * 60);
    const d = steps.reduce((a, s) => a + s.distance, 0);
    expect(d / 1000).toBeCloseTo(8.31, 1);
  });

  it('estime l’allure des blocs qui n’en ont pas et cale la durée annoncée', () => {
    const w = parseWorkout(BRULURE);
    expect(w.blocks.map((b) => [b.repeat, b.steps.map((s) => s.name).join('+')])).toEqual([
      [1, 'EF'],
      [5, 'Rapide+Lent'],
      [1, 'EF'],
    ]);
    const steps = resolveSteps(w);
    const ef = steps[0].pace;
    expect(ef).toBe(384);
    const rapide = steps.find((s) => s.step.name === 'Rapide')!;
    const lent = steps.find((s) => s.step.name === 'Lent')!;
    expect(rapide.paceSource).toBe('estimée');
    expect(rapide.pace).toBeLessThan(ef * 0.8);
    expect(lent.pace).toBeGreaterThan(ef);
    expect(Math.round(totalTime(w))).toBe(47 * 60 + 30);
  });

  it('une allure saisie remplace l’estimation', () => {
    const w = parseWorkout(BRULURE);
    w.blocks[1].steps[0].paceOverride = 270;
    const rapide = resolveSteps(w).find((s) => s.step.name === 'Rapide')!;
    expect(rapide).toMatchObject({ pace: 270, paceSource: 'saisie' });
  });

  it('plan : une section par bloc, cadence selon la vitesse, coupures aux changements', () => {
    const plan = workoutPlan(parseWorkout(FRACTIONNE), estimateCadence);
    expect(plan.sections).toHaveLength(10);
    expect(plan.sections[1].label).toBe('Training (1/4)');
    expect(plan.sections[1].cadence).toBeGreaterThan(plan.sections[2].cadence);
    expect(plan.totalTime).toBeCloseTo(2640);
    const cuts = stepBoundaries(plan);
    expect(cuts[0]).toBeCloseTo(360);
    expect(cuts).toHaveLength(8); // dernier « Rest » et « Cool Down » à la même allure : pas de coupure
  });

  it('formats simples, marche et erreurs', () => {
    const w = parseWorkout('Échauffement\n10 min\nMarche\n2 min\nSprint\n30 s\nAllure : 4:00');
    expect(w.blocks.map((b) => b.steps[0].kind)).toEqual(['warmup', 'walk', 'fast']);
    const plan = workoutPlan(w, estimateCadence, 330);
    expect(plan.sections[1].cadence).toBe(115);
    expect(plan.sections[2].pace).toBe(240);
    expect(() => parseWorkout('Juste un titre\nSans blocs')).toThrow(/Aucun bloc/);
    expect(parsePaceInput("4'45")).toBe(285);
    expect(parsePaceInput('5:30')).toBe(330);
    expect(parsePaceInput('abc')).toBeUndefined();
  });
});

describe('playlist d’une séance', () => {
  it('coupe les morceaux aux changements d’allure quand le lecteur le permet', async () => {
    const { generatePlaylist } = await import('../src/core/playlist');
    const plan = workoutPlan(parseWorkout(BRULURE), estimateCadence);
    const cadences = [...new Set(plan.sections.map((s) => s.cadence))];
    // Morceaux de 4 min à chaque cadence de la séance.
    const library = cadences.flatMap((c) => Array.from({ length: 12 }, (_, i) => ({ id: `${c}-${i}`, title: `T${c}-${i}`, artist: 'A', bpm: c, duration: 240 })));
    const cutAt = stepBoundaries(plan);
    const cut = generatePlaylist(plan, library, { cutAt, maxStretch: 0, seed: 3 });
    const plain = generatePlaylist(plan, library, { maxStretch: 0, seed: 3 });
    expect(cut.matchRatio).toBeGreaterThan(0.95);
    expect(cut.matchRatio).toBeGreaterThan(plain.matchRatio);
    // Chaque sprint de 30 s a son propre morceau, coupé, démarré après l'introduction.
    const sprints = plan.sections.filter((s) => s.label?.startsWith('Rapide'));
    for (const s of sprints) {
      const e = cut.entries.find((x) => Math.abs(x.startTime - s.startTime) < 0.5)!;
      expect(e.endTime).toBeCloseTo(s.endTime, 3);
      expect(e).toMatchObject({ cut: true, songStart: 60, effectiveCadence: s.cadence });
    }
    expect(plain.entries.some((e) => e.cut)).toBe(false);
  });
});
