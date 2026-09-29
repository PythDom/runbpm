import { describe, expect, it } from 'vitest';
import { averageOver, cadenceAt, distanceAt, effortSpeedFactor, estimateCadence, minettiCost, planRun } from '../src/core/pacing';
import type { Section } from '../src/core/sections';

const sec = (startDist: number, length: number, grade: number): Section => ({
  startDist,
  endDist: startDist + length,
  length,
  eleStart: 0,
  eleEnd: grade * length,
  grade,
});

const hilly = [sec(0, 1000, 0), sec(1000, 1000, 0.08), sec(2000, 1000, -0.08)];

describe('modèle', () => {
  it('le coût de Minetti est minimal autour de -10 %', () => {
    expect(minettiCost(0)).toBeCloseTo(3.6);
    expect(minettiCost(0.1)).toBeGreaterThan(minettiCost(0));
    expect(minettiCost(-0.1)).toBeLessThan(minettiCost(0));
  });
  it('à effort constant, on ralentit en montée', () => {
    expect(effortSpeedFactor(0.08)).toBeLessThan(1);
    expect(effortSpeedFactor(-0.05)).toBeGreaterThan(1);
    expect(effortSpeedFactor(-0.3)).toBeLessThanOrEqual(1.15);
  });
  it('la cadence estimée augmente avec la vitesse', () => {
    expect(estimateCadence(10)).toBe(170);
    expect(estimateCadence(15)).toBeGreaterThan(estimateCadence(10));
  });
});

describe('planRun', () => {
  it('allure constante : temps = distance / vitesse', () => {
    const plan = planRun(hilly, { targetPace: 300, mode: 'pace', baseCadence: 172 });
    expect(plan.totalTime).toBeCloseTo(900);
    expect(plan.sections.map((s) => s.cadence)).toEqual([172, 177, 174]);
  });

  it('effort constant : même temps total, montée plus lente', () => {
    const plan = planRun(hilly, { targetPace: 300, mode: 'effort' });
    expect(plan.totalTime).toBeCloseTo(900, 5);
    expect(plan.sections[1].pace).toBeGreaterThan(plan.sections[0].pace);
    expect(plan.sections[2].pace).toBeLessThan(plan.sections[0].pace);
  });

  it('temps et distances cohérents', () => {
    const plan = planRun(hilly, { targetPace: 360 });
    expect(cadenceAt(plan, 0)).toBe(plan.sections[0].cadence);
    expect(cadenceAt(plan, 1e9)).toBe(plan.sections[2].cadence);
    expect(distanceAt(plan, plan.sections[1].startTime)).toBeCloseTo(1000);
    expect(distanceAt(plan, 1e9)).toBe(3000);
  });

  it('averageOver pondère par le temps', () => {
    const plan = planRun(hilly, { targetPace: 300, baseCadence: 170, uphillSensitivity: 1, downhillSensitivity: 0 });
    // 0–300 s : 170 ; 300–600 s : 178
    expect(averageOver(plan, 0, 600, (c) => c)).toBeCloseTo(174);
    // au-delà de l'arrivée, la dernière cadence est prolongée
    expect(averageOver(plan, 900, 1000, (c) => c)).toBe(170);
  });
});
