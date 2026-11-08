import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../server.js';

describe('health', () => {
  it('GET /health answers OK', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });

  it('GET /health/ready reports checks', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.cache).toBeDefined();
    expect(res.body.checks.queue).toBeDefined();
  });
});

describe('pages', () => {
  it('GET / renders the home page', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Snatcher');
    expect(res.text).toContain('Grab any video');
  });

  for (const platform of ['instagram', 'youtube', 'pinterest', 'tiktok', 'facebook', 'twitter']) {
    it(`GET /${platform} renders`, async () => {
      const res = await request(app).get(`/${platform}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Snatch it');
    });
  }

  it('GET /unknown-platform redirects to the error page', async () => {
    const res = await request(app).get('/not-a-platform');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/error?code=not_found');
  });

  it('GET /error?code=not_found is a 404 with the space page', async () => {
    const res = await request(app).get('/error?code=not_found');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Lost in space.');
  });

  it('GET /error?code=timeout is a 504', async () => {
    const res = await request(app).get('/error?code=timeout');
    expect(res.status).toBe(504);
    expect(res.text).toContain('Took too long.');
  });

  it('GET /error?code=bogus falls back to the unknown page', async () => {
    const res = await request(app).get('/error?code=bogus');
    expect(res.status).toBe(500);
    expect(res.text).toContain('Something broke on our side.');
  });
});

describe('YouTube API', () => {
  it('POST /api/youtube/info without a url is a 400', async () => {
    const res = await request(app).post('/api/youtube/info').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_url');
  });

  it('POST /api/youtube/info with a non-YouTube url is a 400', async () => {
    const res = await request(app)
      .post('/api/youtube/info')
      .send({ url: 'https://example.com/watch?v=x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_url');
  });

  it('POST /api/youtube/convert without url and format is a 400', async () => {
    const res = await request(app).post('/api/youtube/convert').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/youtube/convert rejects a format id with shell characters', async () => {
    const res = await request(app)
      .post('/api/youtube/convert')
      .send({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', formatId: '137; rm -rf /' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_url');
  });
});

describe('platform download', () => {
  it('POST /instagram/download with a localhost url is a 400 (SSRF)', async () => {
    const res = await request(app)
      .post('/instagram/download')
      .send({ url: 'http://localhost:3000/health' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_url');
  });

  it('POST /instagram/download with a lookalike host is a 400', async () => {
    const res = await request(app)
      .post('/instagram/download')
      .send({ url: 'https://instagram.com.evil.com/reel/abc' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_url');
  });

  it('POST /instagram/download with garbage is a 400', async () => {
    const res = await request(app).post('/instagram/download').send({ url: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_url');
  });

  it('POST /youtube/download is rejected — YouTube uses the info flow', async () => {
    const res = await request(app)
      .post('/youtube/download')
      .send({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_platform');
  });
});

describe('batch', () => {
  it('POST /api/batch with no urls is a 400', async () => {
    const res = await request(app).post('/api/batch').send({ urls: [] });
    expect(res.status).toBe(400);
  });

  it('POST /api/batch with 11 urls is a 400', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://www.instagram.com/reel/x${i}/`);
    const res = await request(app).post('/api/batch').send({ urls });
    expect(res.status).toBe(400);
  });
});

describe('signed download proxy', () => {
  it('GET /dl without a signature is a 403', async () => {
    const res = await request(app).get('/dl?u=https://example.com/x.mp4');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('GET /dl with a forged signature is a 403', async () => {
    const res = await request(app).get('/dl?u=https://example.com/x.mp4&sig=deadbeef');
    expect(res.status).toBe(403);
  });
});
