import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { getPngPreview } from '../api/image-preview.mjs';

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); body.copy(output, 4); output.writeUInt32BE(crc32(body), data.length + 8); return output;
}
function rgbPng(width, height) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) { const offset = y * (width * 3 + 1) + 1 + x * 3; rows[offset] = x % 256; rows[offset + 1] = y % 256; rows[offset + 2] = 128; }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG previews are resized once and shared by concurrent requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yahahagame-preview-'));
  const source = path.join(root, 'source.png'); await fs.writeFile(source, rgbPng(720, 480));
  const options = { sourcePath: source, cacheRoot: path.join(root, 'cache'), artifactId: 'artifact-preview-test' };
  const [first, second] = await Promise.all([getPngPreview(options), getPngPreview(options)]);
  assert.equal(first, second);
  const output = await fs.readFile(first);
  assert.equal(output.subarray(16, 20).readUInt32BE(), 360);
  assert.equal(output.subarray(20, 24).readUInt32BE(), 240);
  assert.ok(output.length < (await fs.stat(source)).size);
});
