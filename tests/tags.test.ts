import { describe, expect, it } from 'vitest';
import { fileStem, guessFromFileName, normalizeName } from '../src/core/names';
import { bytesReader, readTags } from '../src/core/tags';

// ---------- constructeurs de fichiers de test ----------
const enc = new TextEncoder();
const bytes = (...parts: (number[] | Uint8Array | string)[]) => {
  const arrs = parts.map((p) => (typeof p === 'string' ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const synch = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];

function id3Frame(id: string, payload: Uint8Array, v4: boolean) {
  return bytes(id, v4 ? synch(payload.length) : be32(payload.length), [0, 0], payload);
}
function id3(version: 3 | 4, frames: Uint8Array[], padding = 20) {
  const body = bytes(...frames, new Uint8Array(padding));
  return bytes('ID3', [version, 0, 0], synch(body.length), body);
}
/** Trame MPEG-1 Layer III 128 kbit/s 44,1 kHz stéréo, avec en-tête Xing optionnel. */
function mpegFrame(xingFrames?: number) {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  if (xingFrames !== undefined) frame.set(bytes('Xing', be32(1), be32(xingFrames)), 4 + 32);
  return frame;
}
const utf16 = (s: string) => bytes([1, 0xff, 0xfe], Uint8Array.from(Buffer.from(s, 'utf16le')));
const latin = (s: string) => bytes([0], s);
const utf8 = (s: string) => bytes([3], enc.encode(s));

const read = (b: Uint8Array) => readTags(bytesReader(b), b.length);

describe('MP3', () => {
  it('ID3v2.3 (latin-1, UTF-16) + durée Xing', async () => {
    const file = bytes(
      id3(3, [id3Frame('TIT2', latin('Allez'), false), id3Frame('TPE1', utf16('Zaz Élodie'), false), id3Frame('TBPM', latin('174'), false)]),
      mpegFrame(1000),
      new Uint8Array(5000),
    );
    const t = await read(file);
    expect(t).toMatchObject({ title: 'Allez', artist: 'Zaz Élodie', bpm: 174 });
    expect(t.duration).toBeCloseTo((1000 * 1152) / 44100, 3);
  });

  it('ID3v2.4 (UTF-8, tailles synchsafe) + TLEN', async () => {
    const file = bytes(id3(4, [id3Frame('TIT2', utf8('Café ☕'), true), id3Frame('TPE1', utf8('Moi'), true), id3Frame('TLEN', utf8('215000'), true)]), mpegFrame());
    expect(await read(file)).toMatchObject({ title: 'Café ☕', artist: 'Moi', duration: 215 });
  });

  it('ID3v1 seul, durée par débit constant', async () => {
    const audio = new Uint8Array(160_000);
    audio.set(mpegFrame());
    const v1 = new Uint8Array(128);
    v1.set(bytes('TAG', 'Titre v1'), 0);
    v1.set(bytes('Artiste v1'), 33);
    const file = bytes(audio, v1);
    const t = await read(file);
    expect(t).toMatchObject({ title: 'Titre v1', artist: 'Artiste v1' });
    expect(t.duration).toBeCloseTo((file.length * 8) / 128000, 1);
    expect(t.bpm).toBeUndefined();
  });

  it('ignore un BPM aberrant', async () => {
    const file = bytes(id3(3, [id3Frame('TBPM', latin('0'), false)]), mpegFrame(10));
    expect((await read(file)).bpm).toBeUndefined();
  });
});

describe('autres formats', () => {
  const vorbis = (fields: string[]) =>
    bytes(le32(6), 'vendor', le32(fields.length), ...fields.flatMap((f) => [le32(enc.encode(f).length), enc.encode(f)]));

  it('FLAC', async () => {
    const streamInfo = new Uint8Array(34);
    const sr = 44100;
    const total = sr * 200;
    streamInfo[10] = sr >> 12;
    streamInfo[11] = (sr >> 4) & 255;
    streamInfo[12] = (sr & 15) << 4;
    streamInfo.set(be32(total), 14);
    const comments = vorbis(['TITLE=Titre FLAC', 'artist=Groupe', 'BPM=171,5']);
    const file = bytes('fLaC', [0, 0, 0, 34], streamInfo, [0x84, 0, (comments.length >> 8) & 255, comments.length & 255], comments);
    expect(await read(file)).toMatchObject({ title: 'Titre FLAC', artist: 'Groupe', bpm: 171.5, duration: 200 });
  });

  it('Ogg Vorbis', async () => {
    const file = bytes('OggS', new Uint8Array(40), '\x03vorbis', vorbis(['TITLE=Ogg', 'ARTIST=X']));
    expect(await read(file)).toMatchObject({ title: 'Ogg', artist: 'X' });
  });

  it('MP4 / M4A avec « moov » en fin de fichier', async () => {
    const atom = (type: string, ...body: Uint8Array[]) => {
      const b = bytes(...body);
      return bytes(be32(b.length + 8), type, b);
    };
    const data = (type: number, payload: Uint8Array) => atom('data', bytes(be32(type), be32(0), payload));
    const mvhd = atom('mvhd', bytes([0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(215500), new Uint8Array(80)));
    const ilst = atom(
      'ilst',
      atom('©nam', data(1, enc.encode('Titre M4A'))),
      atom('©ART', data(1, enc.encode('Artiste M4A'))),
      atom('tmpo', data(21, Uint8Array.from([0, 176]))),
    );
    const moov = atom('moov', mvhd, atom('udta', atom('meta', Uint8Array.from([0, 0, 0, 0]), ilst)));
    const file = bytes(atom('ftyp', bytes('M4A ', be32(0))), atom('mdat', new Uint8Array(300_000)), moov);
    expect(await read(file)).toMatchObject({ title: 'Titre M4A', artist: 'Artiste M4A', bpm: 176, duration: 215.5 });
  });

  it('WAV avec LIST/INFO', async () => {
    const info = bytes('INFO', 'INAM', le32(6), 'Titre\0', 'IART', le32(4), 'Moi\0');
    const fmt = bytes('fmt ', le32(16), [1, 0, 1, 0], le32(8000), le32(16000), [2, 0, 16, 0]);
    const file = bytes('RIFF', le32(0), 'WAVE', fmt, 'LIST', le32(info.length), info, 'data', le32(32000), new Uint8Array(32000));
    expect(await read(file)).toMatchObject({ title: 'Titre', artist: 'Moi', duration: 2 });
  });
});

describe('noms de fichiers', () => {
  it('devine artiste et titre', () => {
    expect(guessFromFileName('Musique/03 - Daft Punk - Around the World.mp3')).toEqual({ artist: 'Daft Punk', title: 'Around the World' });
    expect(guessFromFileName('Titre_seul.flac')).toEqual({ title: 'Titre seul' });
    expect(fileStem('2000 Miles.mp3')).toBe('2000 Miles');
    expect(normalizeName('Éléphant & Café !')).toBe('elephant and cafe');
  });
});
