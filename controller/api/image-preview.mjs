import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const previewLocks = new Map();

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(input) {
  if (input.length < 33 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8, width, height, colorType, bitDepth, interlace;
  const data = [];
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset); offset += 4;
    const type = input.toString('ascii', offset, offset + 4); offset += 4;
    if (length > input.length - offset - 4) return null;
    const chunk = input.subarray(offset, offset + length); offset += length;
    offset += 4;
    if (type === 'IHDR') {
      if (length !== 13) return null;
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      bitDepth = chunk[8]; colorType = chunk[9]; interlace = chunk[12];
    } else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') break;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!width || !height || width * height > 16_000_000 || bitDepth !== 8 || !channels || interlace !== 0 || !data.length) return null;
  const rowBytes = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(data));
  if (raw.length !== height * (rowBytes + 1)) return null;
  const pixels = Buffer.alloc(height * rowBytes), prior = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)], source = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const target = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= channels ? target[x - channels] : 0, up = prior[x], upperLeft = x >= channels ? prior[x - channels] : 0;
      target[x] = (source[x] + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0)) & 255;
    }
    target.copy(prior);
  }
  return { width, height, channels, pixels };
}

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type), body = Buffer.concat([name, data]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); body.copy(output, 4); output.writeUInt32BE(crc32(body), data.length + 8);
  return output;
}

function encodePng(image) {
  const rows = Buffer.alloc(image.height * (image.width * image.channels + 1));
  for (let y = 0; y < image.height; y++) {
    const row = y * (image.width * image.channels + 1);
    rows[row] = 0;
    image.pixels.copy(rows, row + 1, y * image.width * image.channels, (y + 1) * image.width * image.channels);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0); header.writeUInt32BE(image.height, 4);
  header[8] = 8; header[9] = image.channels === 4 ? 6 : 2;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(rows, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function resize(image, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) return image;
  const pixels = Buffer.alloc(width * height * image.channels);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / width));
      const from = (sourceY * image.width + sourceX) * image.channels, to = (y * width + x) * image.channels;
      image.pixels.copy(pixels, to, from, from + image.channels);
    }
  }
  return { width, height, channels: image.channels, pixels };
}

async function generate(sourcePath, previewPath, maxWidth, maxHeight) {
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat || sourceStat.size > 64 * 1024 * 1024) return null;
  let image;
  try { image = decodePng(await fs.readFile(sourcePath)); } catch { return null; }
  if (!image) return null;
  await fs.mkdir(path.dirname(previewPath), { recursive: true });
  const temporary = `${previewPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, encodePng(resize(image, maxWidth, maxHeight)), { flag: 'wx' });
    await fs.rename(temporary, previewPath).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      await fs.rm(temporary, { force: true });
    });
    return previewPath;
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function getPngPreview({ sourcePath, cacheRoot, artifactId, maxWidth = 360, maxHeight = 240 }) {
  const previewPath = path.join(cacheRoot, `${artifactId}-${maxWidth}x${maxHeight}.png`);
  try { await fs.access(previewPath); return previewPath; } catch {}
  if (previewLocks.has(previewPath)) return previewLocks.get(previewPath);
  const promise = generate(sourcePath, previewPath, maxWidth, maxHeight).finally(() => previewLocks.delete(previewPath));
  previewLocks.set(previewPath, promise);
  return promise;
}
