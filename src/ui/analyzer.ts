import { detectTempo, mixToMono } from '../core/bpm';
import type { Song } from '../core/library';
import { AUDIO_EXTENSIONS, guessFromFileName } from '../core/names';
import { blobReader, readTags } from '../core/tags';

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

/** Analyse un fichier ; lève une erreur explicite en cas d'échec. */
export async function analyzeFile(file: File, opts: AnalyzeOptions): Promise<Song> {
  const tags = await readTags(blobReader(file), file.size);
  const guess = guessFromFileName(file.webkitRelativePath || file.name);
  const base = {
    id: `f${Date.now().toString(36)}${++idCounter}`,
    title: tags.title ?? guess.title,
    artist: tags.artist ?? guess.artist ?? 'Artiste inconnu',
    file: file.webkitRelativePath || file.name,
    fileKey: fileKey(file),
  };

  if (opts.useTagBpm && tags.bpm && tags.duration) {
    return { ...base, bpm: Math.round(tags.bpm * 10) / 10, duration: Math.round(tags.duration), bpmSource: 'tag' };
  }

  // MP3 volumineux : on décode une tranche au milieu (les trames MP3 se resynchronisent seules).
  const isMp3 = /\.mp3$/i.test(file.name) || file.type === 'audio/mpeg';
  let audio: AudioBuffer | undefined;
  let partial = false;
  if (isMp3 && file.size > MP3_SLICE_BYTES * 1.5) {
    const start = (tags.audioStart ?? 0) + Math.floor((file.size - (tags.audioStart ?? 0) - MP3_SLICE_BYTES) / 2);
    try {
      audio = await decode(await file.slice(start, start + MP3_SLICE_BYTES).arrayBuffer());
      partial = true;
    } catch {
      audio = undefined;
    }
  }
  if (!audio) {
    try {
      audio = await decode(await file.arrayBuffer());
    } catch {
      throw new Error('format non décodable par le navigateur');
    }
  }

  const duration = tags.duration ?? (partial ? undefined : audio.duration);
  if (!duration || duration < 20) throw new Error('durée inconnue ou trop courte');

  // Extrait central de 90 s maximum.
  const len = Math.min(audio.length, ANALYSIS_SECONDS * audio.sampleRate);
  const from = Math.floor((audio.length - len) / 2);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio!.getChannelData(c).subarray(from, from + len));
  const tempo = detectTempo(mixToMono(channels), audio.sampleRate);
  if (!tempo) throw new Error('aucune pulsation détectée');

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
