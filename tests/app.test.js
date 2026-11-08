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

  it('GET /error carries a WhatsApp report link with the failed URL prefilled', async () => {
    const res = await request(app).get(
      '/error?code=forbidden&url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    );
    expect(res.status).toBe(403);
    expect(res.text).toContain('Report on WhatsApp');
    // wa.me link to the owner's number; the message carries the error + link.
    expect(res.text).toContain('https://wa.me/923136701631?text=');
    expect(res.text).toContain(encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    expect(res.text).toContain('forbidden');
  });

  it('GET /error drops a non-URL ?url= from the report link', async () => {
    const res = await request(app).get(
      '/error?code=timeout&url=' + encodeURIComponent('javascript:alert(1)')
    );
    expect(res.status).toBe(504);
    expect(res.text).toContain('https://wa.me/923136701631?text=');
    expect(res.text).not.toContain('javascript');
    expect(res.text).toContain(encodeURIComponent('not given'));
  });

  it('header has the hamburger toggle for small screens', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('nav-toggle');
    expect(res.text).toContain('id="siteNav"');
    expect(res.text).toContain('aria-controls="siteNav"');
  });

  it('GET /favicon.ico serves the favicon instead of a 404', async () => {
    const res = await request(app).get('/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
  });
});

describe('static assets', () => {
  it('stylesheet is served with max-age 0 so theme changes reach browsers', async () => {
    const res = await request(app).get('/css/styles.css');
    expect(res.status).toBe(200);
    // A long cache once left the old theme stuck in browsers for a day after
    // a redeploy. max-age 0 + ETag means revalidation every load, 304 when
    // unchanged, and the new file the moment it changes.
    expect(res.headers['cache-control']).toMatch(/max-age=0/);
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
