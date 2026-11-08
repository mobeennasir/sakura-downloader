'use strict';

const pino = require('pino');
const config = require('./config');

// Pino with pino-pretty: colourised, human-readable log lines.
// Dev (default): colours + multi-line object dumps — the pretty output the
// user loves seeing in the terminal.
// Production (Koyeb, NODE_ENV=production): single-line, no ANSI colours.
// Koyeb's log viewer cannot render colours, so coloured multi-line dumps
// show up as escape-code noise; one event = one clean line there instead.
// Set LOG_PRETTY=0 for raw JSON, e.g. when shipping logs to a collector.
const pretty = process.env.LOG_PRETTY !== '0';
const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: config.logLevel,
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: !isProd,
            singleLine: isProd,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

module.exports = logger;
