import { detectTempo, mixToMono } from '../core/bpm';
import type { Song } from '../core/library';
import { AUDIO_EXTENSIONS, guessFromFileName } from '../core/names';
import { blobReader, readTags, type ReadFn } from '../core/tags';

/**
 * Construction de la bibliothèque à partir de fichiers audio : métadonnées (tags ou nom de
 * fichier) et tempo (tag BPM, ou analyse du signal).
 */

export interface AnalyzeOptions {
  /** Utiliser le BPM présent dans les tags au lieu d'analyser le signal. */
  useTagBpm: boolean;
}

export interface AnalyzeProgress {
  done: number;
  total: number;
  current?: string;
  added: number;
  failed: number;
}

/** Fréquence de décodage : suffisante pour la détection des attaques, légère en mémoire. */
const DECODE_RATE = 22050;
/** Durée analysée (secondes), prise au milieu du morceau. */
const ANALYSIS_SECONDS = 90;
/** Taille de la tranche décodée pour les MP3 volumineux (≈ 1 à 2 min selon le débit). */
const MP3_SLICE_BYTES = 2.5 * 1024 * 1024;

export function fileKey(file: File): string {
  return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
}

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name);
}

let idCounter = 0;

async function decode(buffer: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
  return ctx.decodeAudioData(buffer);
}

/** Source audio lisible par morceaux : fichier local ou fichier distant (Navidrome). */
export interface AudioSource {
  /** Nom ou chemin, pour les messages et la détection du format. */
  name: string;
  size: number;
  /** Lecture d'une plage d'octets. */
  read: ReadFn;
  /** Contenu décodable complet (ou extrait transcodé) si la tranche MP3 ne suffit pas. */
  readForDecoding(): Promise<ArrayBuffer>;
  /** Dernier recours si le contenu précédent n'est pas décodable (ex. fichier d'origine complet). */
  fallbackForDecoding?(): Promise<ArrayBuffer>;
}

export function fileSource(file: File): AudioSource {
  return {
    name: file.webkitRelativePath || file.name,
    size: file.size,
    read: blobReader(file),
    readForDecoding: () => file.arrayBuffer(),
  };
}

/**
 * Mesure le tempo d'une source. Pour un MP3 volumineux, seule une tranche centrale est lue et
 * décodée (les trames MP3 se resynchronisent seules).
 */
export async function measureTempo(src: AudioSource, audioStart = 0): Promise<{ bpm: number; confidence: number; decodedDuration?: number }> {
  let audio: AudioBuffer | undefined;
  let partial = false;
  if (/\.mp3$/i.test(src.name) && src.size > MP3_SLICE_BYTES * 1.5) {
    const start = audioStart + Math.floor((src.size - audioStart - MP3_SLICE_BYTES) / 2);
    try {
      const bytes = await src.read(start, MP3_SLICE_BYTES);
      audio = await decode(bytes.slice().buffer);
      partial = true;
    } catch {
      audio = undefined;
    }
  }
  if (!audio) {
    try {
      audio = await decode(await src.readForDecoding());
    } catch {
      if (!src.fallbackForDecoding) throw new Error('format non décodable par le navigateur');
      try {
        audio = await decode(await src.fallbackForDecoding());
      } catch {
        throw new Error('format non décodable par le navigateur');
      }
    }
  }
  // Extrait central de 90 s maximum.
  const len = Math.min(audio.length, ANALYSIS_SECONDS * audio.sampleRate);
  const from = Math.floor((audio.length - len) / 2);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio!.getChannelData(c).subarray(from, from + len));
  const tempo = detectTempo(mixToMono(channels), audio.sampleRate);
  if (!tempo) throw new Error('aucune pulsation détectée');
  return { ...tempo, decodedDuration: partial ? undefined : audio.duration };
}

/** Analyse un fichier local ; lève une erreur explicite en cas d'échec. */
export async function analyzeFile(file: File, opts: AnalyzeOptions): Promise<Song> {
  const src = fileSource(file);
  const tags = await readTags(src.read, src.size);
  const guess = guessFromFileName(src.name);
  const base = {
    id: `f${Date.now().toString(36)}${++idCounter}`,
    title: tags.title ?? guess.title,
    artist: tags.artist ?? guess.artist ?? 'Artiste inconnu',
    file: src.name,
    fileKey: fileKey(file),
  };

  if (opts.useTagBpm && tags.bpm && tags.duration) {
    return { ...base, bpm: Math.round(tags.bpm * 10) / 10, duration: Math.round(tags.duration), bpmSource: 'tag' };
  }
  const tempo = await measureTempo(src, tags.audioStart);
  const duration = tags.duration ?? tempo.decodedDuration;
  if (!duration || duration < 20) throw new Error('durée inconnue ou trop courte');
  return { ...base, bpm: tempo.bpm, duration: Math.round(duration), bpmSource: 'analyse', confidence: tempo.confidence };
}

/**
 * Analyse une liste de fichiers, l'un après l'autre (mémoire maîtrisée), en ignorant ceux déjà
 * présents dans la bibliothèque. `onSong` reçoit chaque morceau dès qu'il est prêt.
 */
export async function analyzeFiles(
  files: File[],
  known: Set<string>,
  opts: AnalyzeOptions,
  onSong: (song: Song) => void,
  onProgress: (p: AnalyzeProgress) => void,
  signal: { cancelled: boolean },
): Promise<{ progress: AnalyzeProgress; errors: string[] }> {
  const todo = files.filter((f) => isAudioFile(f) && !known.has(fileKey(f)));
  const progress: AnalyzeProgress = { done: 0, total: todo.length, added: 0, failed: 0 };
  const errors: string[] = [];
  onProgress(progress);
  for (const file of todo) {
    if (signal.cancelled) break;
    progress.current = file.webkitRelativePath || file.name;
    onProgress(progress);
    try {
      onSong(await analyzeFile(file, opts));
      progress.added++;
    } catch (e) {
      progress.failed++;
      errors.push(`${file.name} : ${(e as Error).message}`);
    }
    progress.done++;
    onProgress(progress);
    // Laisse respirer l'interface entre deux fichiers.
    await new Promise((r) => setTimeout(r, 0));
  }
  progress.current = undefined;
  return { progress, errors };
}
