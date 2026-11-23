import { describe, expect, it } from 'vitest';
import { removeActivity } from '../src/ui/profiles';

const seg = (cadence: number) => ({ speedKmh: 10, gradePct: 0, cadence, weight: 60 });

describe('rechargement d’une sortie du calibrage', () => {
  it('retire la sortie et ses seuls tronçons', () => {
    const cal = {
      activities: [
        { name: 'a.csv', distanceKm: 1, segments: 2 },
        { name: 'b.csv', distanceKm: 1, segments: 3 },
        { name: 'c.csv', distanceKm: 1, segments: 1 },
      ],
      segments: [seg(1), seg(1), seg(2), seg(2), seg(2), seg(3)],
    };
    expect(removeActivity(cal, 'b.csv')).toBe(true);
    expect(cal.activities.map((a) => a.name)).toEqual(['a.csv', 'c.csv']);
    expect(cal.segments.map((s) => s.cadence)).toEqual([1, 1, 3]);
    expect(removeActivity(cal, 'x.csv')).toBe(false);
  });

  it('tient compte des tronçons anciens déjà élagués', () => {
    const cal = {
      activities: [
        { name: 'a.csv', distanceKm: 1, segments: 3 },
        { name: 'b.csv', distanceKm: 1, segments: 2 },
      ],
      segments: [seg(1), seg(2), seg(2)], // deux tronçons de a.csv élagués
    };
    removeActivity(cal, 'a.csv');
    expect(cal.segments.map((s) => s.cadence)).toEqual([2, 2]);
    removeActivity(cal, 'b.csv');
    expect(cal.segments).toEqual([]);
  });
});
