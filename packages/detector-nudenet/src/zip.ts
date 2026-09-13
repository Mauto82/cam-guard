import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Extract one file from a zip archive held in memory.
 *
 * Just enough of the format to read a Python wheel (stored or deflated, no
 * zip64, no encryption), so pulling one model out of it needs no dependency.
 */
export function extractFromZip(zip: Buffer, entryName: string): Buffer {
  // The end-of-central-directory record sits in the last 22 bytes plus an
  // optional comment of up to 64 KiB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end of central directory)");

  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error("corrupt zip central directory");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== entryName) continue;

    if (zip.readUInt32LE(localOffset) !== LOCAL) throw new Error("corrupt zip local header");
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(start, start + compressedSize);
    const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    if (!out) throw new Error(`unsupported zip compression method ${method} for ${name}`);
    if (out.length !== size) throw new Error(`${name}: expected ${size} bytes, got ${out.length}`);
    return out;
  }
  throw new Error(`${entryName} not found in archive`);
}
