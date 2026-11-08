'use strict';

// One error taxonomy for the whole app. Every failure the user can see is a
// SnatcherError with a stable machine code, an HTTP status, and a short
// human message. The code also picks the animated error page (see ERROR_PAGES).

const logger = require('./logger');

class SnatcherError extends Error {
  constructor(code, status, message, options = {}) {
    super(message);
    this.name = 'SnatcherError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable !== undefined ? options.retryable : false;
  }
}

const Errors = {
  invalidUrl: (detail) =>
    new SnatcherError(
      'invalid_url',
      400,
      detail || 'That is not a link we can use.'
    ),
  unsupportedPlatform: (detail) =>
    new SnatcherError(
      'unsupported_platform',
      400,
      detail || 'That platform is not supported yet.'
    ),
  notFound: (detail) =>
    new SnatcherError('not_found', 404, detail || 'Lost in space.'),
  linkNotFound: (detail) =>
    new SnatcherError(
      'link_not_found',
      404,
      detail || 'That link went nowhere.'
    ),
  privateOrRemoved: (detail) =>
    new SnatcherError(
      'private_or_removed',
      404,
      detail || 'That one is locked.'
    ),
  forbidden: (detail) =>
    new SnatcherError('forbidden', 403, detail || 'Access denied.'),
  rateLimited: (detail) =>
    new SnatcherError(
      'rate_limited',
      429,
      detail || 'Too fast. Slow down.',
      { retryable: true }
    ),
  upstreamTimeout: (detail) =>
    new SnatcherError('timeout', 504, detail || 'Took too long.', {
      retryable: true,
    }),
  upstreamError: (detail) =>
    new SnatcherError(
      'upstream_error',
      502,
      detail || 'The platform stumbled.',
      { retryable: true }
    ),
  noMedia: (detail) =>
    new SnatcherError(
      'no_media',
      404,
      detail || 'No media in that link.'
    ),
  unknown: (detail) =>
    new SnatcherError(
      'unknown',
      500,
      detail || 'Something broke on our side.'
    ),
};

// What the animated error page shows for each code.
const ERROR_PAGES = {
  not_found: {
    title: 'Lost in space.',
    line: 'That page drifted off somewhere. The link may be wrong, or the page may be gone.',
    animation: 'space',
    status: 404,
  },
  link_not_found: {
    title: 'That link went nowhere.',
    line: 'Nothing at that address came back with media. Check the link and try again.',
    animation: 'broken-link',
    status: 404,
  },
  private_or_removed: {
    title: 'That one is locked.',
    line: 'The post is private, removed, or only visible to its owner.',
    animation: 'lock',
    status: 404,
  },
  forbidden: {
    title: 'Access denied.',
    line: 'The platform would not let us in. It may be private or region-locked.',
    animation: 'lock',
    status: 403,
  },
  rate_limited: {
    title: 'Too fast. Slow down.',
    line: 'The platform asked us to wait. Give it a minute and try again.',
    animation: 'meter',
    status: 429,
  },
  timeout: {
    title: 'Took too long.',
    line: 'The platform answered too slowly. Try again — it usually works the second time.',
    animation: 'hourglass',
    status: 504,
  },
  upstream_error: {
    title: 'The platform stumbled.',
    line: 'The service we ask for media had a bad moment. Try again shortly.',
    animation: 'crack',
    status: 502,
  },
  invalid_url: {
    title: 'That is not a link we can use.',
    line: 'Paste a full link to a post, reel, pin or video from a supported platform.',
    animation: 'broken-link',
    status: 400,
  },
  unsupported_platform: {
    title: 'Not supported yet.',
    line: 'Snatcher works with Instagram, Facebook, TikTok, Twitter/X and Pinterest.',
    animation: 'empty',
    status: 400,
  },
  no_media: {
    title: 'No media in that link.',
    line: 'The page opened, but there was nothing downloadable inside it.',
    animation: 'empty',
    status: 404,
  },
  unknown: {
    title: 'Something broke on our side.',
    line: 'An undefined error. It is logged — try again, and if it keeps happening, tell us.',
    animation: 'crack',
    status: 500,
  },
};

// A verdict error is final: another client or adapter will not change it.
// Anything else (timeout, upstream failure) is worth one retry elsewhere.
function isVerdictError(err) {
  return (
    err instanceof SnatcherError &&
    ['private_or_removed', 'link_not_found', 'invalid_url'].includes(err.code)
  );
}

function errorPageFor(code) {
  return ERROR_PAGES[code] || ERROR_PAGES.unknown;
}

// Convert any thrown value into a SnatcherError. Upstream internals are never
// leaked to the client — the message is always one of ours. Anything we cannot
// map is logged here, so an "undefined error" never disappears silently.
function toSnatcherError(err) {
  if (err instanceof SnatcherError) return err;

  const message = (err && err.message) || String(err || '');
  const code = err && err.code;

  if (code === 'ECONNABORTED' || /timeout|timed out|ETIMEDOUT/i.test(message)) {
    return Errors.upstreamTimeout();
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    /socket disconnected|socket hang up/i.test(message)
  ) {
    return Errors.upstreamError('The media service could not be reached.');
  }
  if (err && err.response && typeof err.response.status === 'number') {
    const status = err.response.status;
    if (status === 404) return Errors.linkNotFound();
    if (status === 403) return Errors.forbidden();
    if (status === 429) return Errors.rateLimited();
    if (status >= 500) return Errors.upstreamError();
  }
  if (/not found|private|removed|unavailable/i.test(message)) {
    return Errors.linkNotFound();
  }
  if (/rate.?limit|too many requests/i.test(message)) {
    return Errors.rateLimited();
  }
  logger.error({ err }, 'could not map error');
  return Errors.unknown();
}

module.exports = { SnatcherError, Errors, ERROR_PAGES, errorPageFor, toSnatcherError, isVerdictError };
