import { describe, expect, it } from 'vitest';
import type { Song } from '../src/core/library';
import type { Playlist, PlaylistEntry } from '../src/core/playlist';
import { entryIndexAt, findEntryByUri } from '../src/core/timeline';

const entry = (id: string, start: number, end: number, uri?: string): PlaylistEntry => ({
  song: { id, title: id, artist: 'x', bpm: 170, duration: end - start, spotifyUri: uri } as Song,
  startTime: start,
  endTime: end,
  targetCadence: 170,
  multiplier: 1,
  playbackRate: 1,
  effectiveCadence: 170,
  error: 0,
  repeated: false,
});
const playlist = (entries: PlaylistEntry[]): Playlist => ({ entries, totalDuration: entries.at(-1)!.endTime, matchRatio: 1, warnings: [] });

describe('timeline', () => {
  const p = playlist([entry('a', 0, 200, 'u:a'), entry('b', 200, 380, 'u:b'), entry('a2', 380, 580, 'u:a')]);

  it('trouve le morceau censé jouer', () => {
    expect(entryIndexAt(p, 0)).toBe(0);
    expect(entryIndexAt(p, 199.9)).toBe(0);
    expect(entryIndexAt(p, 200)).toBe(1);
    expect(entryIndexAt(p, 579)).toBe(2);
    expect(entryIndexAt(p, 580)).toBe(-1);
  });

  it('retrouve un morceau joué par Spotify, occurrence la plus proche', () => {
    expect(findEntryByUri(p, 'u:b', 0)).toBe(1);
    expect(findEntryByUri(p, 'u:a', 0)).toBe(0);
    expect(findEntryByUri(p, 'u:a', 2)).toBe(2);
    expect(findEntryByUri(p, 'u:zzz', 0)).toBe(-1);
    expect(findEntryByUri(p, undefined, 0)).toBe(-1);
  });
});
