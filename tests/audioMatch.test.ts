import { describe, expect, it } from 'vitest';
import { fileStem, matchAudioFiles, normalizeName } from '../src/core/audioMatch';
import type { Song } from '../src/core/library';

const song = (id: string, title: string, artist: string, file?: string): Song => ({ id, title, artist, bpm: 170, duration: 200, file });

describe('normalisation', () => {
  it('ignore accents, casse, ponctuation, numéro de piste et extension', () => {
    expect(normalizeName('Éléphant & Café !')).toBe('elephant and cafe');
    expect(fileStem('Musique/Album/03 - Mon Titre.mp3')).toBe('Mon Titre');
    expect(fileStem('12. Autre.flac')).toBe('Autre');
    expect(fileStem('2000 Miles.mp3')).toBe('2000 Miles');
  });
});

describe('matchAudioFiles', () => {
  it('associe par colonne fichier, puis artiste + titre, puis titre', () => {
    const songs = [
      song('a', 'Run', 'Band', 'music/track-a.mp3'),
      song('b', 'Hill Climb', 'Groupe'),
      song('c', 'Descente', 'Quelqu’un'),
      song('d', 'Absent', 'Personne'),
    ];
    const files = ['Descente.ogg', '01 - Groupe - Hill Climb.mp3', 'track-a.mp3', 'autre.mp3'];
    const m = matchAudioFiles(songs, files);
    expect(m.get('a')).toBe(2);
    expect(m.get('b')).toBe(1);
    expect(m.get('c')).toBe(0);
    expect(m.has('d')).toBe(false);
  });

  it('n’utilise chaque fichier qu’une fois et préfère le meilleur score', () => {
    const songs = [song('x', 'Love', 'A'), song('y', 'Love', 'B')];
    const m = matchAudioFiles(songs, ['B - Love.mp3']);
    expect(m.get('y')).toBe(0);
    expect(m.has('x')).toBe(false);
  });

  it('ne s’appuie pas sur les titres par défaut', () => {
    expect(matchAudioFiles([song('z', 'Sans titre', 'Artiste inconnu')], ['sans titre.mp3']).size).toBe(0);
  });

  it('évite les correspondances partielles de mots', () => {
    expect(matchAudioFiles([song('r', 'Rain', 'X')], ['Rainbow.mp3']).size).toBe(0);
  });
});
