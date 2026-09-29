import type { Song } from './library';

/**
 * Association entre les morceaux de la bibliothèque et des fichiers audio locaux,
 * à partir des noms de fichiers.
 *
 * Par ordre de priorité :
 *  1. nom de fichier identique à la colonne "fichier" de la bibliothèque,
 *  2. nom de fichier = « artiste titre » ou « titre artiste »,
 *  3. nom de fichier contenant le titre et l'artiste,
 *  4. nom de fichier = titre,
 *  5. nom de fichier contenant le titre.
 * Les numéros de piste en tête (« 01 - », « 3. ») et l'extension sont ignorés.
 */

const DEFAULT_TITLES = new Set(['sans titre']);
const DEFAULT_ARTISTS = new Set(['artiste inconnu']);

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Nom de fichier sans dossier, sans extension ni numéro de piste. */
export function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/^\s*\d{1,3}\s*[-._)]\s*/, '');
}

const containsWords = (haystack: string, needle: string) => ` ${haystack} `.includes(` ${needle} `);

function score(song: Song, stem: string, rawBase: string): number {
  if (song.file && normalizeName(fileStem(song.file)) === stem) return 100;
  if (song.file && normalizeName((song.file.split(/[\\/]/).pop() ?? '').replace(/\.[a-z0-9]{1,5}$/i, '')) === rawBase) return 100;
  const title = DEFAULT_TITLES.has(song.title.toLowerCase()) ? '' : normalizeName(song.title);
  const artist = DEFAULT_ARTISTS.has(song.artist.toLowerCase()) ? '' : normalizeName(song.artist);
  if (!title) return 0;
  if (artist && (stem === `${artist} ${title}` || stem === `${title} ${artist}`)) return 90;
  if (artist && containsWords(stem, title) && containsWords(stem, artist)) return 80;
  if (stem === title && title.length >= 3) return 70;
  if (title.length >= 4 && containsWords(stem, title)) return 50;
  return 0;
}

/**
 * Renvoie, pour chaque morceau associé, l'indice du fichier retenu.
 * Chaque fichier et chaque morceau n'est utilisé qu'une fois (meilleurs scores d'abord).
 */
export function matchAudioFiles(songs: Song[], fileNames: string[]): Map<string, number> {
  const stems = fileNames.map((f) => normalizeName(fileStem(f)));
  const rawBases = fileNames.map((f) => normalizeName((f.split(/[\\/]/).pop() ?? f).replace(/\.[a-z0-9]{1,5}$/i, '')));
  const pairs: { songId: string; file: number; score: number }[] = [];
  for (const song of songs) {
    for (let i = 0; i < fileNames.length; i++) {
      const s = score(song, stems[i], rawBases[i]);
      if (s > 0) pairs.push({ songId: song.id, file: i, score: s });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const result = new Map<string, number>();
  const usedFiles = new Set<number>();
  for (const p of pairs) {
    if (result.has(p.songId) || usedFiles.has(p.file)) continue;
    result.set(p.songId, p.file);
    usedFiles.add(p.file);
  }
  return result;
}

export const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;
