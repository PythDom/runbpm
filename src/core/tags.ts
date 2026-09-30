/**
 * Lecture des métadonnées des fichiers audio (titre, artiste, BPM, durée), sans dépendance.
 *
 *  - MP3 : ID3v2.2/2.3/2.4 (TIT2, TPE1, TBPM, TLEN), ID3v1, durée par en-tête Xing/Info/VBRI
 *          ou, à défaut, par le débit (CBR).
 *  - FLAC : STREAMINFO (durée) et VORBIS_COMMENT (TITLE, ARTIST, BPM).
 *  - Ogg Vorbis / Opus : commentaires (TITLE, ARTIST, BPM).
 *  - MP4 / M4A : atomes ©nam, ©ART, tmpo et durée (mvhd).
 *  - WAV : durée (fmt/data) et LIST/INFO (INAM, IART).
 *
 * La lecture se fait par morceaux via `read(offset, length)` : inutile de charger tout le fichier.
 */

export interface TagInfo {
  title?: string;
  artist?: string;
  bpm?: number;
  /** Durée en secondes. */
  duration?: number;
  /** Octet où commence l'audio (après l'éventuel en-tête ID3v2). */
  audioStart?: number;
}

export type ReadFn = (offset: number, length: number) => Promise<Uint8Array>;

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u24be = (b: Uint8Array, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const synchsafe = (b: Uint8Array, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

const clean = (s: string | undefined) => {
  const v = s?.replace(/\0+$/g, '').split('\0')[0].trim();
  return v ? v : undefined;
};

function parseBpm(s: string | undefined): number | undefined {
  const n = Number.parseFloat((s ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= 40 && n <= 260 ? n : undefined;
}

// ---------- ID3 ----------

function decodeText(b: Uint8Array): string {
  if (b.length === 0) return '';
  const enc = b[0];
  const body = b.subarray(1);
  if (enc === 0) return latin1.decode(body);
  if (enc === 3) return utf8.decode(body);
  if (enc === 1) {
    // UTF-16 avec BOM (plusieurs valeurs possibles, séparées par des BOM).
    const le = !(body[0] === 0xfe && body[1] === 0xff);
    const start = (body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff) ? 2 : 0;
    return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(body.subarray(start)).replace(/﻿/g, '');
  }
  if (enc === 2) return new TextDecoder('utf-16be').decode(body);
  return latin1.decode(body);
}

export function parseId3v2(b: Uint8Array): { tags: TagInfo; size: number } | undefined {
  if (ascii(b, 0, 3) !== 'ID3') return undefined;
  const version = b[3];
  const flags = b[5];
  const size = synchsafe(b, 6) + 10 + (flags & 0x10 ? 10 : 0);
  const tags: TagInfo = {};
  let pos = 10;
  if (flags & 0x40 && version >= 3) {
    // En-tête étendu.
    pos += version === 4 ? synchsafe(b, pos) : u32be(b, pos) + 4;
  }
  const end = Math.min(size, b.length);
  const idLen = version === 2 ? 3 : 4;
  const headerLen = version === 2 ? 6 : 10;
  while (pos + headerLen <= end) {
    const id = ascii(b, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // remplissage
    const frameSize = version === 2 ? u24be(b, pos + 3) : version === 4 ? synchsafe(b, pos + 4) : u32be(b, pos + 4);
    const data = b.subarray(pos + headerLen, pos + headerLen + frameSize);
    pos += headerLen + frameSize;
    if (frameSize <= 0) continue;
    const text = () => clean(decodeText(data));
    switch (id) {
      case 'TIT2':
      case 'TT2':
        tags.title ??= text();
        break;
      case 'TPE1':
      case 'TP1':
        tags.artist ??= text();
        break;
      case 'TBPM':
      case 'TBP':
        tags.bpm ??= parseBpm(text());
        break;
      case 'TLEN':
      case 'TLE': {
        const ms = Number.parseFloat(text() ?? '');
        if (ms > 1000) tags.duration ??= ms / 1000;
        break;
      }
    }
  }
  return { tags, size };
}

export function parseId3v1(tail: Uint8Array): TagInfo | undefined {
  if (tail.length < 128) return undefined;
  const t = tail.subarray(tail.length - 128);
  if (ascii(t, 0, 3) !== 'TAG') return undefined;
  return { title: clean(latin1.decode(t.subarray(3, 33))), artist: clean(latin1.decode(t.subarray(33, 63))) };
}

// ---------- MPEG (durée) ----------

const BITRATES: Record<string, number[]> = {
  // [version][layer] en kbit/s, index 1..14
  '1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** Durée d'un MP3 à partir de la première trame (Xing/Info/VBRI, sinon débit constant). */
export function mpegDuration(b: Uint8Array, offsetInFile: number, fileSize: number): number | undefined {
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (b[i + 1] >> 3) & 3;
    const layerBits = (b[i + 1] >> 1) & 3;
    const brIndex = b[i + 2] >> 4;
    const srIndex = (b[i + 2] >> 2) & 3;
    if (verBits === 1 || layerBits === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) continue;
    const version = verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const bitrate = BITRATES[`${version === 1 ? 1 : 2}-${layer}`][brIndex - 1] * 1000;
    const sampleRate = SAMPLE_RATES[version][srIndex];
    const mono = b[i + 3] >> 6 === 3;
    const samplesPerFrame = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    const sideInfo = version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xing = i + 4 + sideInfo;
    const tag = ascii(b, xing, 4);
    if ((tag === 'Xing' || tag === 'Info') && u32be(b, xing + 4) & 1) {
      return (u32be(b, xing + 8) * samplesPerFrame) / sampleRate;
    }
    if (ascii(b, i + 36, 4) === 'VBRI') return (u32be(b, i + 36 + 14) * samplesPerFrame) / sampleRate;
    return ((fileSize - (offsetInFile + i)) * 8) / bitrate;
  }
  return undefined;
}

// ---------- Vorbis comments (FLAC, Ogg) ----------

function parseVorbisComments(b: Uint8Array, o: number, tags: TagInfo): void {
  const vendorLen = u32le(b, o);
  let pos = o + 4 + vendorLen;
  const count = u32le(b, pos);
  pos += 4;
  for (let i = 0; i < count && pos + 4 <= b.length; i++) {
    const len = u32le(b, pos);
    const entry = utf8.decode(b.subarray(pos + 4, pos + 4 + len));
    pos += 4 + len;
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = clean(entry.slice(eq + 1));
    if (key === 'TITLE') tags.title ??= value;
    else if (key === 'ARTIST') tags.artist ??= value;
    else if (key === 'BPM' || key === 'TBPM' || key === 'TEMPO') tags.bpm ??= parseBpm(value);
  }
}

function parseFlac(b: Uint8Array): TagInfo {
  const tags: TagInfo = {};
  let pos = 4;
  for (;;) {
    if (pos + 4 > b.length) break;
    const header = b[pos];
    const type = header & 0x7f;
    const len = u24be(b, pos + 1);
    const body = pos + 4;
    if (type === 0 && body + 18 <= b.length) {
      const sampleRate = (b[body + 10] << 12) | (b[body + 11] << 4) | (b[body + 12] >> 4);
      const totalSamples = (b[body + 13] & 0x0f) * 2 ** 32 + u32be(b, body + 14);
      if (sampleRate > 0 && totalSamples > 0) tags.duration = totalSamples / sampleRate;
    } else if (type === 4 && body + len <= b.length) {
      parseVorbisComments(b, body, tags);
    }
    pos = body + len;
    if (header & 0x80) break;
  }
  return tags;
}

function indexOf(b: Uint8Array, pattern: string, from = 0): number {
  const p = Array.from(pattern, (c) => c.charCodeAt(0));
  outer: for (let i = from; i <= b.length - p.length; i++) {
    for (let k = 0; k < p.length; k++) if (b[i + k] !== p[k]) continue outer;
    return i;
  }
  return -1;
}

function parseOgg(b: Uint8Array): TagInfo {
  const tags: TagInfo = {};
  const vorbis = indexOf(b, '\x03vorbis');
  if (vorbis >= 0) parseVorbisComments(b, vorbis + 7, tags);
  else {
    const opus = indexOf(b, 'OpusTags');
    if (opus >= 0) parseVorbisComments(b, opus + 8, tags);
  }
  return tags;
}

// ---------- MP4 ----------

async function parseMp4(read: ReadFn, fileSize: number): Promise<TagInfo> {
  const tags: TagInfo = {};
  // Parcourt les atomes de premier niveau pour trouver « moov » (souvent à la fin du fichier).
  let pos = 0;
  let moov: Uint8Array | undefined;
  while (pos + 8 <= fileSize) {
    const h = await read(pos, 16);
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    if (size === 1) size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
    else if (size === 0) size = fileSize - pos;
    if (size < 8) break;
    if (type === 'moov') {
      moov = await read(pos, Math.min(size, 32 * 1024 * 1024));
      break;
    }
    pos += size;
  }
  if (!moov) return tags;

  const walk = (start: number, end: number, visit: (type: string, body: number, end: number) => void) => {
    let p = start;
    while (p + 8 <= end) {
      const size = u32be(moov!, p);
      const type = ascii(moov!, p + 4, 4);
      if (size < 8 || p + size > end) break;
      visit(type, p + 8, p + size);
      p += size;
    }
  };
  const dataOf = (start: number, end: number): { type: number; payload: Uint8Array } | undefined => {
    let found: { type: number; payload: Uint8Array } | undefined;
    walk(start, end, (t, body, e) => {
      if (t === 'data') found = { type: u32be(moov!, body), payload: moov!.subarray(body + 8, e) };
    });
    return found;
  };
  walk(8, moov.length, (type, body, end) => {
    if (type === 'mvhd') {
      const v = moov![body];
      const timescale = v === 1 ? u32be(moov!, body + 20) : u32be(moov!, body + 12);
      const duration = v === 1 ? u32be(moov!, body + 24) * 2 ** 32 + u32be(moov!, body + 28) : u32be(moov!, body + 16);
      if (timescale > 0) tags.duration = duration / timescale;
    } else if (type === 'udta') {
      walk(body, end, (t2, b2, e2) => {
        if (t2 !== 'meta') return;
        walk(b2 + 4, e2, (t3, b3, e3) => {
          if (t3 !== 'ilst') return;
          walk(b3, e3, (item, b4, e4) => {
            const d = dataOf(b4, e4);
            if (!d) return;
            if (item === '©nam') tags.title = clean(utf8.decode(d.payload));
            else if (item === '©ART') tags.artist = clean(utf8.decode(d.payload));
            else if (item === 'tmpo' && d.payload.length >= 2) tags.bpm = parseBpm(String((d.payload[0] << 8) | d.payload[1]));
          });
        });
      });
    }
  });
  return tags;
}

// ---------- WAV ----------

function parseWav(b: Uint8Array, fileSize: number): TagInfo {
  const tags: TagInfo = {};
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = ascii(b, pos, 4);
    const size = u32le(b, pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') byteRate = u32le(b, body + 8);
    else if (id === 'data') {
      if (byteRate > 0) tags.duration = Math.min(size, fileSize - body) / byteRate;
    } else if (id === 'LIST' && ascii(b, body, 4) === 'INFO') {
      let p = body + 4;
      while (p + 8 <= body + size && p + 8 <= b.length) {
        const sub = ascii(b, p, 4);
        const len = u32le(b, p + 4);
        const value = clean(utf8.decode(b.subarray(p + 8, p + 8 + len)));
        if (sub === 'INAM') tags.title ??= value;
        else if (sub === 'IART') tags.artist ??= value;
        p += 8 + len + (len & 1);
      }
    }
    if (id === 'data') break;
    pos = body + size + (size & 1);
  }
  return tags;
}

// ---------- Point d'entrée ----------

const HEAD = 256 * 1024;

export async function readTags(read: ReadFn, fileSize: number): Promise<TagInfo> {
  const head = await read(0, Math.min(HEAD, fileSize));
  const magic = ascii(head, 0, 4);

  if (magic === 'fLaC') return parseFlac(head);
  if (magic === 'OggS') return parseOgg(head);
  if (magic === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return parseWav(head, fileSize);
  if (ascii(head, 4, 4) === 'ftyp') return parseMp4(read, fileSize);

  // MP3 (avec ou sans ID3v2).
  let tags: TagInfo = {};
  let audioStart = 0;
  const id3 = parseId3v2(head.length >= 10 ? head : new Uint8Array(0));
  if (id3) {
    let full = head;
    if (id3.size > head.length) full = await read(0, Math.min(id3.size, fileSize));
    const parsed = parseId3v2(full)!;
    tags = parsed.tags;
    audioStart = parsed.size;
  }
  if (!tags.title || !tags.artist) {
    const v1 = parseId3v1(await read(Math.max(0, fileSize - 128), Math.min(128, fileSize)));
    if (v1) tags = { ...v1, ...Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined)) };
  }
  if (!tags.duration) {
    const frame = await read(audioStart, Math.min(8192, Math.max(0, fileSize - audioStart)));
    tags.duration = mpegDuration(frame, audioStart, fileSize);
  }
  tags.audioStart = audioStart;
  return tags;
}

/** Lecteur par morceaux pour un tableau d'octets (tests) ou un objet File (navigateur). */
export function bytesReader(bytes: Uint8Array): ReadFn {
  return async (offset, length) => bytes.subarray(offset, offset + length);
}

export function blobReader(blob: Blob): ReadFn {
  return async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}
