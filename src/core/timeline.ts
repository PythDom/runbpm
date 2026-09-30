import type { Playlist } from './playlist';

/**
 * Chronologie de la playlist pendant la course : quel morceau est censé jouer à un instant donné,
 * et à quel instant correspond un morceau signalé par le service de streaming.
 */

/** Indice du morceau joué au temps t (secondes depuis le départ), -1 après la fin. */
export function entryIndexAt(playlist: Playlist, t: number): number {
  const entries = playlist.entries;
  if (entries.length === 0) return -1;
  if (t < entries[0].startTime) return 0;
  for (let i = 0; i < entries.length; i++) if (t < entries[i].endTime) return i;
  return -1;
}

/**
 * Retrouve dans la playlist le morceau que joue le service (par identifiant Spotify).
 * Si le morceau apparaît plusieurs fois (répétitions), on prend l'occurrence la plus proche de
 * l'indice courant. Renvoie -1 s'il n'est pas dans la playlist.
 */
export function findEntryByUri(playlist: Playlist, uri: string | undefined, near: number): number {
  if (!uri) return -1;
  let best = -1;
  playlist.entries.forEach((e, i) => {
    if (e.song.spotifyUri !== uri) return;
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  });
  return best;
}
