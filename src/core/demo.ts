import type { Song } from './library';
import { rng } from './playlist';

/**
 * Bibliothèque fictive pour essayer l'application sans importer ses propres morceaux.
 * Les titres et artistes sont inventés ; seuls les tempos et durées comptent.
 */
export function demoLibrary(): Song[] {
  const random = rng(42);
  const words = ['Pulse', 'Stride', 'Horizon', 'Summit', 'Velocity', 'Echo', 'Ridge', 'Tempo', 'Drift', 'Spark', 'Canyon', 'Neon'];
  const artists = ['Démo Collective', 'The Placeholders', 'Groupe Exemple', 'Lorem Ipsum Band', 'DJ Test'];
  const songs: Song[] = [];
  const addRange = (from: number, to: number, perBpm: number) => {
    for (let bpm = from; bpm <= to; bpm++) {
      for (let k = 0; k < perBpm; k++) {
        const w1 = words[Math.floor(random() * words.length)];
        const w2 = words[Math.floor(random() * words.length)];
        songs.push({
          id: `demo-${bpm}-${k}`,
          title: `${w1} ${w2} ${bpm}`,
          artist: artists[Math.floor(random() * artists.length)],
          bpm,
          duration: Math.round(160 + random() * 120),
        });
      }
    }
  };
  addRange(150, 195, 1); // Tempos « un pas par temps »
  addRange(78, 96, 1); // Tempos mi-tempo (×2 = 156–192)
  return songs;
}
