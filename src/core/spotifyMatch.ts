import { normalizeName } from './names';
import type { Song } from './library';

/** Résultat de recherche Spotify réduit à ce qui sert à la comparaison. */
export interface TrackCandidate {
  uri: string;
  name: string;
  artists: string[];
  durationMs: number;
}

/**
 * Titre « nettoyé » : sans mentions entre parenthèses ou crochets (feat., remix…) ni suffixe
 * après un tiret (« - Remastered 2011 », « - Radio Edit »).
 */
export function cleanTitle(title: string): string {
  return normalizeName(
    title
      .replace(/\s*[([].*?[)\]]/g, ' ')
      .replace(/\s+-\s+.*$/, ' ')
      .replace(/\b(feat|ft)\.?\s.*$/i, ' '),
  );
}

const containsWords = (haystack: string, needle: string) =>
  needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);

/** Requête de recherche Spotify pour un morceau (filtres track: et artist:). */
export function searchQuery(song: Song): string {
  const strip = (s: string) => s.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
  const title = strip(song.title.replace(/\s*[([].*?[)\]]/g, ' '));
  const unknownArtist = song.artist.toLowerCase() === 'artiste inconnu';
  return unknownArtist ? `track:${title}` : `track:${title} artist:${strip(song.artist)}`;
}

/**
 * Choisit le candidat qui correspond au morceau : titre identique (ou contenu), au moins un
 * artiste commun, et durée proche si elle est connue. Renvoie undefined si rien n'est assez sûr.
 */
export function pickBestTrack(song: Song, candidates: TrackCandidate[]): TrackCandidate | undefined {
  const title = cleanTitle(song.title);
  const artist = normalizeName(song.artist);
  const unknownArtist = artist === 'artiste inconnu';
  let best: { c: TrackCandidate; score: number } | undefined;

  for (const c of candidates) {
    const cTitle = cleanTitle(c.name);
    const titleScore = cTitle === title ? 1 : containsWords(cTitle, title) || containsWords(title, cTitle) ? 0.7 : 0;
    if (titleScore === 0) continue;

    const cArtists = c.artists.map(normalizeName);
    const artistScore = unknownArtist
      ? 0.5
      : cArtists.some((a) => a === artist)
        ? 1
        : cArtists.some((a) => containsWords(artist, a) || containsWords(a, artist))
          ? 0.8
          : 0;
    if (artistScore === 0) continue;

    const dt = Math.abs(c.durationMs / 1000 - song.duration);
    const durationScore = dt <= 5 ? 0.3 : dt <= 15 ? 0.1 : dt > 45 ? -0.4 : 0;
    const score = titleScore + artistScore + durationScore;
    if (score >= 1.4 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c;
}
