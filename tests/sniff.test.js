// Content sniffing: igdl hands back extension-less proxy URLs, so the
// extension guess called every Instagram image a video and the file was
// saved as .mp4. The first bytes never lie — JPEG/PNG/WebP/GIF/MP4 magic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { classifyMediaBytes, sniffMediaType } from '../src/media.js';

const pad = (head, total = 16) => Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, total - head.length))]);

describe('classifyMediaBytes', () => {
  it('JPEG → image/jpg', () => {
    expect(classifyMediaBytes(pad([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ type: 'image', ext: 'jpg' });
  });
  it('PNG → image/png', () => {
    expect(classifyMediaBytes(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ type: 'image', ext: 'png' });
  });
  it('WebP → image/webp', () => {
    const buf = pad([]);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    expect(classifyMediaBytes(buf)).toEqual({ type: 'image', ext: 'webp' });
  });
  it('GIF → image/gif', () => {
    const buf = pad([]);
    buf.write('GIF89a', 0, 'ascii');
    expect(classifyMediaBytes(buf)).toEqual({ type: 'image', ext: 'gif' });
  });
  it('ftyp at bytes 4-7 → video/mp4', () => {
    const buf = pad([]);
    buf.write('ftyp', 4, 'ascii');
    expect(classifyMediaBytes(buf)).toEqual({ type: 'video', ext: 'mp4' });
  });
  it('unknown bytes → null', () => {
    expect(classifyMediaBytes(pad([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
  it('short buffer → null', () => {
    expect(classifyMediaBytes(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('sniffMediaType', () => {
  let server;
  let base;
  const jpeg = pad([0xff, 0xd8, 0xff, 0xe0], 63206);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      // Serves the full JPEG and IGNORES Range — the sniff must still
      // stop after the first chunk instead of downloading the whole file.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(jpeg);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('classifies a JPEG behind a Range-ignoring server as image/jpg', async () => {
    await expect(sniffMediaType(`${base}/v2?token=x`)).resolves.toEqual({ type: 'image', ext: 'jpg' });
  });
  it('returns null for an unreachable URL', async () => {
    await expect(sniffMediaType('http://127.0.0.1:1/nope', 1000)).resolves.toBeNull();
  });
});
