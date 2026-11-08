'use strict';

const dns = require('dns').promises;
const net = require('net');
const { Errors } = require('./errors');

// Per-platform host allowlist. A URL is only fetched server-side when its host
// is on the list for its platform. This is the SSRF defence: no localhost,
// no private IPs, no arbitrary hosts.
const PLATFORM_HOSTS = {
  instagram: ['instagram.com', 'www.instagram.com'],
  youtube: [
    'youtube.com',
    'www.youtube.com',
    'youtu.be',
    'music.youtube.com',
    'www.music.youtube.com',
  ],
  pinterest: ['pinterest.com', 'www.pinterest.com', 'pin.it'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'fb.watch'],
  twitter: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'],
};

const ALL_HOSTS = new Set(Object.values(PLATFORM_HOSTS).flat());
const HOST_TO_PLATFORM = new Map();
for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
  for (const host of hosts) HOST_TO_PLATFORM.set(host, platform);
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // IPv6: loopback, link-local, unique-local.
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd')
  );
}

function detectPlatform(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    return HOST_TO_PLATFORM.get(parsed.hostname.toLowerCase()) || null;
  } catch {
    return null;
  }
}

// Validate a user-supplied media URL. Returns { url, platform } with the URL
// normalised, or throws a SnatcherError. The DNS check rejects hosts that
// resolve to private/loopback/link-local addresses (DNS-rebinding defence).
async function validateMediaUrl(rawUrl, platform) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw Errors.invalidUrl('Paste a link first.');
  }
  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw Errors.invalidUrl();
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw Errors.invalidUrl('Links must start with http or https.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) throw Errors.invalidUrl();

  const allowed = platform
    ? PLATFORM_HOSTS[platform] || []
    : [...ALL_HOSTS];
  if (platform && !PLATFORM_HOSTS[platform]) {
    throw Errors.unsupportedPlatform();
  }
  if (!allowed.includes(host)) {
    if (platform) {
      throw Errors.invalidUrl(`That is not a ${platform} link.`);
    }
    throw Errors.invalidUrl('That link is not from a supported platform.');
  }

  // IP literals are never allowed.
  if (net.isIP(host)) {
    throw Errors.invalidUrl();
  }

  // DNS check: the host must resolve, and only to public addresses.
  try {
    const addresses = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS_TIMEOUT')), 5000)
      ),
    ]);
    if (!addresses || addresses.length === 0) {
      throw Errors.invalidUrl('We could not reach that host.');
    }
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        throw Errors.invalidUrl();
      }
    }
  } catch (err) {
    if (err instanceof Error && err.code === undefined && err.message === 'DNS_TIMEOUT') {
      throw Errors.upstreamTimeout('Looking up that host took too long.');
    }
    if (err && err.name === 'SnatcherError') throw err;
    throw Errors.invalidUrl('We could not reach that host.');
  }

  const detected = HOST_TO_PLATFORM.get(host);
  return { url: parsed.toString(), platform: platform || detected };
}

// Validate a URL the /dl proxy is about to stream. The URL was signed by a
// resolver, so it is not user input anymore — but defence in depth still
// applies: https only, no IP literals, no private/loopback destinations.
async function validateProxyUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw Errors.invalidUrl();
  }
  if (parsed.protocol !== 'https:') throw Errors.invalidUrl();
  const host = parsed.hostname.toLowerCase();
  if (!host || net.isIP(host)) throw Errors.invalidUrl();
  try {
    const addresses = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS_TIMEOUT')), 5000)
      ),
    ]);
    if (!addresses || addresses.length === 0) throw Errors.invalidUrl();
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw Errors.invalidUrl();
    }
  } catch (err) {
    if (err && err.name === 'SnatcherError') throw err;
    throw Errors.invalidUrl();
  }
  return parsed.toString();
}

module.exports = { PLATFORM_HOSTS, ALL_HOSTS, detectPlatform, validateMediaUrl, validateProxyUrl };
