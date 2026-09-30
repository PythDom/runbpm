import { formatDuration } from './library';
import type { RunPlan } from './pacing';
import type { Playlist } from './playlist';

/** Playlist M3U étendue, lisible par VLC, foobar2000, la plupart des lecteurs. */
export function toM3U(playlist: Playlist, title = 'RunBPM'): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${title}`];
  for (const e of playlist.entries) {
    lines.push(`#EXTINF:${Math.round(e.song.duration)},${e.song.artist} - ${e.song.title}`);
    if (e.playbackRate !== 1) {
      lines.push(`#RUNBPM:rate=${e.playbackRate.toFixed(3)},cadence=${e.effectiveCadence}`);
    }
    lines.push(e.song.file ?? `${e.song.artist} - ${e.song.title}`);
  }
  return lines.join('\n') + '\n';
}

function csvField(v: string | number): string {
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(playlist: Playlist): string {
  const header = [
    'ordre',
    'debut',
    'titre',
    'artiste',
    'bpm',
    'mi_tempo',
    'vitesse_lecture',
    'cadence_morceau',
    'cadence_cible',
    'ecart_pct',
    'fichier',
  ];
  const rows = playlist.entries.map((e, i) => [
    i + 1,
    formatDuration(e.startTime),
    e.song.title,
    e.song.artist,
    e.song.bpm,
    e.multiplier === 2 ? 'oui' : 'non',
    e.playbackRate.toFixed(3),
    e.effectiveCadence,
    e.targetCadence,
    (e.error * 100).toFixed(1),
    e.song.file ?? '',
  ]);
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

export function toJson(plan: RunPlan, playlist: Playlist, meta: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      ...meta,
      generatedAt: new Date().toISOString(),
      plan: {
        totalDistance: Math.round(plan.totalDistance),
        totalTime: Math.round(plan.totalTime),
        baseCadence: plan.baseCadence,
        sections: plan.sections.map((s) => ({
          startDist: Math.round(s.startDist),
          endDist: Math.round(s.endDist),
          gradePct: Math.round(s.grade * 1000) / 10,
          pace: Math.round(s.pace),
          cadence: s.cadence,
          startTime: Math.round(s.startTime),
        })),
      },
      playlist: playlist.entries.map((e) => ({
        title: e.song.title,
        artist: e.song.artist,
        bpm: e.song.bpm,
        file: e.song.file,
        startTime: Math.round(e.startTime),
        multiplier: e.multiplier,
        playbackRate: e.playbackRate,
        effectiveCadence: e.effectiveCadence,
        targetCadence: e.targetCadence,
      })),
    },
    null,
    2,
  );
}

/**
 * Liste « Artiste - Titre », une ligne par morceau : format accepté par les services de transfert
 * de playlists (TuneMyMusic, Soundiiz…) pour créer la playlist sur Deezer ou un autre service.
 */
export function toTransferText(playlist: Playlist): string {
  return playlist.entries.map((e) => `${e.song.artist} - ${e.song.title}`).join('\n') + '\n';
}

/** Même liste au format CSV (colonnes titre, artiste). */
export function toTransferCsv(playlist: Playlist): string {
  const rows = playlist.entries.map((e) => [e.song.title, e.song.artist]);
  return [['Track name', 'Artist name'], ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}
