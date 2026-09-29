import { describe, expect, it } from 'vitest';
import { formatDuration, mergeLibraries, parseCsv, parseDuration, parseLibraryCsv, parseLibraryJson } from '../src/core/library';

describe('parseCsv', () => {
  it('gère guillemets, virgules et séparateur point-virgule', () => {
    expect(parseCsv('a,"b, c","d ""e"""\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('x;y\r\n1,5;2\r\n')).toEqual([
      ['x', 'y'],
      ['1,5', '2'],
    ]);
  });
});

describe('parseDuration', () => {
  it('reconnaît les différents formats', () => {
    expect(parseDuration('3:45')).toBe(225);
    expect(parseDuration('1:00:00')).toBe(3600);
    expect(parseDuration('215')).toBe(215);
    expect(parseDuration('215000')).toBe(215);
    expect(parseDuration('9000', 'Duration (ms)')).toBe(9);
  });
});

describe('parseLibraryCsv', () => {
  it('lit un CSV simple', () => {
    const { songs, warnings } = parseLibraryCsv('titre;artiste;bpm;durée\nA;X;172,5;3:30\nB;Y;;3:00\n');
    expect(songs).toHaveLength(1);
    expect(songs[0]).toMatchObject({ title: 'A', artist: 'X', bpm: 172.5, duration: 210 });
    expect(warnings).toHaveLength(1);
  });

  it('lit un export de type Exportify', () => {
    const csv = '"Track URI","Track Name","Artist Name(s)","Duration (ms)","Tempo"\n"spotify:track:1","Song","Band",201000,"174.02"\n';
    const { songs } = parseLibraryCsv(csv);
    expect(songs[0]).toMatchObject({ title: 'Song', artist: 'Band', bpm: 174, duration: 201 });
  });

  it('signale l’absence de colonne BPM', () => {
    expect(() => parseLibraryCsv('title,duration\nA,3:00\n')).toThrow(/BPM/);
  });
});

describe('parseLibraryJson', () => {
  it('lit un tableau de morceaux', () => {
    const { songs } = parseLibraryJson(JSON.stringify({ songs: [{ title: 'A', artist: 'B', tempo: 90, duration_ms: 180000 }] }));
    expect(songs[0]).toMatchObject({ bpm: 90, duration: 180 });
  });
});

describe('utilitaires', () => {
  it('fusionne sans doublons', () => {
    const s = (title: string) => ({ id: title, title, artist: 'a', bpm: 170, duration: 200 });
    expect(mergeLibraries([s('A')], [s('a'), s('B')]).map((x) => x.title)).toEqual(['A', 'B']);
  });
  it('formate les durées', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
