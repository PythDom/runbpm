/** Normalisation de noms (titres, artistes, fichiers) pour les comparaisons. */

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

/** Devine artiste et titre à partir d'un nom de fichier « Artiste - Titre.mp3 ». */
export function guessFromFileName(path: string): { artist?: string; title: string } {
  const stem = fileStem(path).replace(/_/g, ' ').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(stem);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: stem };
}

export const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|mp4|ogg|oga|opus|wav|flac|webm)$/i;
