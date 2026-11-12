'use strict';
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
/** Add only pHYs density to the renderer's PNG; never copy source metadata. */
function pngDensity(bytes, dpi) {
  if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 8).equals(SIGNATURE) || !Number.isFinite(dpi) || dpi < 72 || dpi > 600)
    throw new Error('Invalid print PNG or density');
  const chunk = Buffer.alloc(21); chunk.writeUInt32BE(9); chunk.write('pHYs', 4, 'ascii');
  const pixelsPerMetre = Math.round(dpi * 1000 / 25.4);
  chunk.writeUInt32BE(pixelsPerMetre, 8); chunk.writeUInt32BE(pixelsPerMetre, 12); chunk[16] = 1;
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 17)) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 17);
  const parts = [SIGNATURE]; let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length, type = bytes.toString('ascii', offset + 4, offset + 8);
    if (end > bytes.length || (offset === 8 && (type !== 'IHDR' || length !== 13))) throw new Error('Invalid print PNG chunks');
    if (type !== 'pHYs') parts.push(bytes.subarray(offset, end));
    if (type === 'IHDR') parts.push(chunk);
    offset = end;
    if (type === 'IEND') { ended = offset === bytes.length; break; }
  }
  if (!ended) throw new Error('Incomplete print PNG');
  return Buffer.concat(parts);
}
module.exports = { pngDensity };
