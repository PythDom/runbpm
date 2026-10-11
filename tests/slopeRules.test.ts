import { describe, expect, it } from 'vitest';
import { planRun } from '../src/core/pacing';
import type { Section } from '../src/core/sections';
import { cadenceForGrade, DEFAULT_SLOPE_RULES, rangeLabel, ruleForGrade, withValues } from '../src/core/slopeRules';

describe('règles par pente', () => {
  it('les tranches couvrent toutes les pentes sans trou ni chevauchement', () => {
    for (let i = 1; i < DEFAULT_SLOPE_RULES.length; i++) expect(DEFAULT_SLOPE_RULES[i].from).toBe(DEFAULT_SLOPE_RULES[i - 1].to);
    expect(DEFAULT_SLOPE_RULES[0].from).toBe(-Infinity);
    expect(DEFAULT_SLOPE_RULES.at(-1)!.to).toBe(Infinity);
  });

  it('applique les valeurs par défaut (X = 172)', () => {
    const X = 172;
    expect(cadenceForGrade(X, 0)).toBe(172); // plat
    expect(cadenceForGrade(X, 3)).toBe(172); // montée douce : X
    expect(cadenceForGrade(X, 7)).toBe(175); // montée modérée : X + 3
    expect(cadenceForGrade(X, 12)).toBe(165); // montée raide : X − 7
    expect(cadenceForGrade(X, 18)).toBe(120); // marche active
    expect(cadenceForGrade(X, -3)).toBe(175); // descente douce : X + 3
    expect(cadenceForGrade(X, -7)).toBe(179); // descente modérée : X + 7
    expect(cadenceForGrade(X, -12)).toBe(190); // descente raide : 190
  });

  it('une borne appartient à la tranche la plus raide, en montée comme en descente', () => {
    expect(ruleForGrade(5).id).toBe('up-moderate');
    expect(ruleForGrade(4.99).id).toBe('up-gentle');
    expect(ruleForGrade(-5).id).toBe('down-moderate');
    expect(ruleForGrade(-4.99).id).toBe('down-gentle');
    expect(ruleForGrade(-10).id).toBe('down-steep');
    expect(ruleForGrade(15).id).toBe('up-very-steep');
    expect(ruleForGrade(-0.5).id).toBe('flat');
    expect(ruleForGrade(0.99).id).toBe('flat');
  });

  it('valeurs personnalisées et libellés', () => {
    const rules = withValues({ 'up-moderate': 5, 'down-steep': 196, inconnu: 1 });
    expect(cadenceForGrade(170, 6, rules)).toBe(175);
    expect(cadenceForGrade(170, -15, rules)).toBe(196);
    expect(cadenceForGrade(170, 3, rules)).toBe(170);
    expect(rangeLabel(DEFAULT_SLOPE_RULES[0])).toBe('< -10 %');
    expect(rangeLabel(DEFAULT_SLOPE_RULES[5])).toBe('+5 à +10 %');
    expect(rangeLabel(DEFAULT_SLOPE_RULES.at(-1)!)).toBe('≥ +15 %');
  });

  it('planRun utilise les règles et indique la tranche', () => {
    const sec = (start: number, grade: number): Section => ({ startDist: start, endDist: start + 500, length: 500, eleStart: 0, eleEnd: grade * 500, grade });
    const plan = planRun([sec(0, 0), sec(500, 0.07), sec(1000, 0.18), sec(1500, -0.12)], {
      targetPace: 330,
      mode: 'pace',
      baseCadence: 172,
      slopeRules: DEFAULT_SLOPE_RULES,
    });
    expect(plan.sections.map((s) => s.cadence)).toEqual([172, 175, 120, 190]);
    expect(plan.sections.map((s) => s.ruleId)).toEqual(['flat', 'up-moderate', 'up-very-steep', 'down-steep']);
  });
});
