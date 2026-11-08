'use strict';

// Response cache + request coalescing + upstream queue.
//
// - Identical URLs within the TTL share one cached result (no re-scrape).
// - Concurrent identical requests share one in-flight upstream call.
// - A small queue caps how many upstream calls run at once, so a traffic
//   burst fans out 1:1 to Instagram/TikTok/etc. and invites rate-limiting.

const { LRUCache } = require('lru-cache');
const PQueue = require('p-queue').default;
const config = require('./config');

const cache = new LRUCache({ max: config.cacheMax, ttl: config.cacheTtlMs });
const inflight = new Map();
const queue = new PQueue({ concurrency: config.queueConcurrency });

async function cachedResolve(key, fn) {
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  if (inflight.has(key)) return inflight.get(key);

  const promise = queue
    .add(fn)
    .then((result) => {
      cache.set(key, result);
      inflight.delete(key);
      return result;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });

  inflight.set(key, promise);
  return promise;
}

function cacheStats() {
  return { size: cache.size, max: config.cacheMax, ttlMs: config.cacheTtlMs };
}

module.exports = { cachedResolve, cacheStats, queue };
