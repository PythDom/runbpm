/**
 * Lecture des fichiers FIT (Garmin, Coros, Suunto, Polar, Wahoo…), sans dépendance.
 *
 * Seul ce qui sert au calibrage est extrait : les points d'enregistrement (message « record »)
 * avec temps, position, altitude, distance, vitesse et cadence, ainsi que le sport pratiqué.
 *
 * Format : en-tête, puis une suite de messages de définition (qui décrivent la structure des
 * messages d'un type local) et de messages de données. Référence : FIT SDK, « FIT File Types ».
 */

export interface FitRecord {
  /** Secondes depuis l'époque FIT (31/12/1989 00:00 UTC). */
  timestamp?: number;
  lat?: number;
  lon?: number;
  /** Altitude en mètres. */
  altitude?: number;
  /** Distance cumulée en mètres. */
  distance?: number;
  /** Vitesse en m/s. */
  speed?: number;
  /** Cadence brute du fichier (foulées/min en course chez Garmin : un pied). */
  cadence?: number;
}

export interface FitActivity {
  /** 1 = course à pied (profil FIT), 2 = vélo, etc. */
  sport?: number;
  records: FitRecord[];
  /** Le CRC de fin de fichier ne correspond pas (fichier tronqué ou modifié). */
  crcMismatch: boolean;
}

export const FIT_SPORT_RUNNING = 1;

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface Definition {
  littleEndian: boolean;
  globalNum: number;
  fields: FieldDef[];
  devBytes: number;
}

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

/** Lit un entier selon le type de base FIT ; undefined pour la valeur « invalide » du type. */
function readValue(view: DataView, offset: number, baseType: number, le: boolean): number | undefined {
  switch (baseType) {
    case 0x00: // enum
    case 0x02: // uint8
    case 0x0d: {
      const v = view.getUint8(offset);
      return v === 0xff ? undefined : v;
    }
    case 0x0a: {
      const v = view.getUint8(offset);
      return v === 0 ? undefined : v;
    }
    case 0x01: {
      const v = view.getInt8(offset);
      return v === 0x7f ? undefined : v;
    }
    case 0x84: {
      const v = view.getUint16(offset, le);
      return v === 0xffff ? undefined : v;
    }
    case 0x8b: {
      const v = view.getUint16(offset, le);
      return v === 0 ? undefined : v;
    }
    case 0x83: {
      const v = view.getInt16(offset, le);
      return v === 0x7fff ? undefined : v;
    }
    case 0x86: {
      const v = view.getUint32(offset, le);
      return v === 0xffffffff ? undefined : v;
    }
    case 0x8c: {
      const v = view.getUint32(offset, le);
      return v === 0 ? undefined : v;
    }
    case 0x85: {
      const v = view.getInt32(offset, le);
      return v === 0x7fffffff ? undefined : v;
    }
    case 0x88: {
      const v = view.getFloat32(offset, le);
      return Number.isFinite(v) ? v : undefined;
    }
    case 0x89: {
      const v = view.getFloat64(offset, le);
      return Number.isFinite(v) ? v : undefined;
    }
    default:
      return undefined; // chaînes, 64 bits : non utilisés ici
  }
}

const BASE_SIZE: Record<number, number> = { 0x00: 1, 0x01: 1, 0x02: 1, 0x0a: 1, 0x0d: 1, 0x83: 2, 0x84: 2, 0x8b: 2, 0x85: 4, 0x86: 4, 0x8c: 4, 0x88: 4, 0x89: 8 };

const SEMICIRCLE = 180 / 2 ** 31;
const MSG_RECORD = 20;
const MSG_SESSION = 18;
const MSG_SPORT = 12;

export function parseFit(bytes: Uint8Array): FitActivity {
  if (bytes.length < 12) throw new Error('Fichier FIT trop court.');
  const headerSize = bytes[0];
  const sig = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if ((headerSize !== 12 && headerSize !== 14) || sig !== '.FIT') throw new Error('Ce fichier n’est pas un fichier FIT.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataSize = view.getUint32(4, true);
  const end = Math.min(bytes.length, headerSize + dataSize);
  const crcMismatch = bytes.length >= end + 2 ? fitCrc(bytes, 0, end) !== view.getUint16(end, true) : true;

  const defs = new Map<number, Definition>();
  const records: FitRecord[] = [];
  let sport: number | undefined;
  let lastTimestamp = 0;
  let pos = headerSize;

  while (pos < end) {
    const header = bytes[pos++];
    let localType: number;
    let compressedTs: number | undefined;
    if (header & 0x80) {
      // En-tête compressé : type local sur 2 bits et décalage de temps sur 5 bits.
      localType = (header >> 5) & 0x03;
      const offset = header & 0x1f;
      compressedTs = (lastTimestamp & ~0x1f) + offset + (offset < (lastTimestamp & 0x1f) ? 0x20 : 0);
    } else {
      localType = header & 0x0f;
      if (header & 0x40) {
        // Message de définition.
        const le = bytes[pos + 1] === 0;
        const globalNum = view.getUint16(pos + 2, le);
        const count = bytes[pos + 4];
        pos += 5;
        const fields: FieldDef[] = [];
        for (let i = 0; i < count; i++, pos += 3) fields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: bytes[pos + 2] });
        let devBytes = 0;
        if (header & 0x20) {
          const devCount = bytes[pos++];
          for (let i = 0; i < devCount; i++, pos += 3) devBytes += bytes[pos + 1];
        }
        defs.set(localType, { littleEndian: le, globalNum, fields, devBytes });
        continue;
      }
    }

    const def = defs.get(localType);
    if (!def) throw new Error('Fichier FIT invalide (message sans définition).');
    const values = new Map<number, number>();
    for (const f of def.fields) {
      const size = BASE_SIZE[f.baseType];
      // Tableaux : on ne lit que le premier élément.
      if (size && f.size >= size) {
        const v = readValue(view, pos, f.baseType, def.littleEndian);
        if (v !== undefined) values.set(f.num, v);
      }
      pos += f.size;
    }
    pos += def.devBytes;

    const ts = values.get(253) ?? compressedTs;
    if (ts !== undefined) lastTimestamp = ts;

    if (def.globalNum === MSG_RECORD) {
      const alt = values.get(78) ?? values.get(2);
      const speed = values.get(73) ?? values.get(6);
      const cad = values.get(4);
      const frac = values.get(53);
      const lat = values.get(0);
      const lon = values.get(1);
      records.push({
        timestamp: ts,
        lat: lat !== undefined ? lat * SEMICIRCLE : undefined,
        lon: lon !== undefined ? lon * SEMICIRCLE : undefined,
        altitude: alt !== undefined ? alt / 5 - 500 : undefined,
        distance: values.has(5) ? values.get(5)! / 100 : undefined,
        speed: speed !== undefined ? speed / 1000 : undefined,
        cadence: cad !== undefined ? cad + (frac ?? 0) / 128 : undefined,
      });
    } else if (def.globalNum === MSG_SESSION && values.has(5)) {
      sport ??= values.get(5);
    } else if (def.globalNum === MSG_SPORT && values.has(0)) {
      sport ??= values.get(0);
    }
  }
  return { sport, records, crcMismatch };
}
