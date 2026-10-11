/**
 * Lambda entry point of the console API (handler: index.handler).
 *
 * Everything is set up once per execution environment: the configuration is read and
 * checked, the AWS clients are created, and the handler keeps its short-lived caches
 * in memory between requests. A bad configuration fails here, before any request is
 * served.
 *
 * Lambda calls the handler with the event and with its context object. The handler
 * asks the context how much time is left, so that it can answer and record a request
 * before Lambda would stop the function (see app.mjs).
 */

import { createApp } from './app.mjs';
import { createAws } from './aws.mjs';
import { loadConfig } from './config.mjs';

const config = loadConfig(process.env);

export const handler = createApp({ aws: createAws(process.env), config });
