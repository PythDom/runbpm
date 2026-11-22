import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { corosDetailUrl, corosToWorkout, fetchCorosWorkout, parseCorosLink } from '../src/core/coros';
import { resolveSteps, totalTime } from '../src/core/workout';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/coros-program.json', import.meta.url), 'utf8'));

describe('séances COROS par lien', () => {
  it('reconnaît les liens de partage et de Training Hub', () => {
    expect(parseCorosLink('https://sharepageeu.coros.com/share/training/program/481936773369479170/region-3-time-1795355803')).toEqual({ id: '481936773369479170', region: 3 });
    expect(parseCorosLink('https://t.coros.com/workout-program?programId=481936773369479170&region=3')).toEqual({ id: '481936773369479170', region: 3 });
    expect(parseCorosLink('https://t.coros.com/workout-program?programId=12&region=99')).toEqual({ id: '12', region: 1 });
    expect(parseCorosLink('Warm Up\n1.00 km')).toBeUndefined();
    expect(parseCorosLink('https://example.com/program/1')).toBeUndefined();
    expect(corosDetailUrl({ id: '481936773369479170', region: 3 })).toBe(
      'https://teameuapi.coros.com/training/program/detail?id=481936773369479170&region=3&supportRestExercise=1',
    );
  });

  it('convertit la séance : groupes répétés, durées, allures, totaux', () => {
    const w = corosToWorkout(fixture.data);
    expect(w.title).toBe('42KM-S9-3-Endurance de Force');
    expect(w.totalDuration).toBe(3180);
    expect(w.totalDistance).toBeCloseTo(4724.41);
    expect(w.blocks.map((b) => [b.repeat, b.steps.map((s) => `${s.name}:${s.kind}:${s.duration}`).join('+')])).toEqual([
      [1, 'EF:easy:1200'],
      [3, 'Rapide:fast:30+Lent:recovery:180'],
      [1, 'Lent:recovery:120'],
      [3, 'Rapide:fast:30+Lent:recovery:180'],
      [1, 'EF:easy:600'],
    ]);
    expect(w.blocks[0].steps[0]).toMatchObject({ paceLow: 366, paceHigh: 396 });
    expect(Math.round(totalTime(w))).toBe(3180);
    expect(resolveSteps(w)).toHaveLength(15);
  });

  it('distances en centimètres, repos programmés, allures par mile', () => {
    const w = corosToWorkout({
      name: 'Test',
      exercises: [
        { id: '1', name: 'Échauffement', exerciseType: 1, targetType: 5, targetValue: 100000, intensityType: 3, intensityValue: 600, intensityValueExtend: 660, intensityDisplayUnit: 2, restType: 1, restValue: 90, sortNo: 1 },
        { id: '2', name: 'Manuel', targetType: 1, targetValue: 0, sortNo: 2 },
      ],
    });
    expect(w.blocks).toHaveLength(1);
    const [warm, rest] = w.blocks[0].steps;
    expect(warm).toMatchObject({ kind: 'warmup', distance: 1000, paceLow: 373, paceHigh: 410 });
    expect(rest).toMatchObject({ kind: 'recovery', duration: 90 });
  });

  it('téléchargement : URL de la région, erreurs lisibles', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(fixture)));
    const w = await fetchCorosWorkout({ id: '481936773369479170', region: 3 }, ok as unknown as typeof fetch);
    expect((ok.mock.calls[0] as unknown as [string])[0]).toContain('teameuapi.coros.com');
    expect(w.blocks).toHaveLength(5);
    const missing = vi.fn(async () => new Response(JSON.stringify({ result: '1019', message: 'not found' })));
    await expect(fetchCorosWorkout({ id: '1', region: 3 }, missing as unknown as typeof fetch)).rejects.toThrow(/introuvable \(not found\)/);
    const down = vi.fn(async () => { throw new TypeError('network'); });
    await expect(fetchCorosWorkout({ id: '1', region: 3 }, down as unknown as typeof fetch)).rejects.toThrow(/injoignable/);
  });
});
