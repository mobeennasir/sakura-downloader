'use strict';

const pino = require('pino');
const config = require('./config');

// Pino with pino-pretty: colourised, human-readable log lines. Pretty logs
// are on by default (the user loves seeing them); set LOG_PRETTY=0 for raw
// JSON, e.g. when shipping logs to a collector.
const pretty = process.env.LOG_PRETTY !== '0';

const logger = pino({
  level: config.logLevel,
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

module.exports = logger;
