/**
 * Lambda entry point of the console API (handler: index.handler).
 *
 * Everything is set up once per execution environment: the configuration is read and
 * checked, the AWS clients are created, and the handler keeps its short-lived caches
 * in memory between requests. A bad configuration fails here, before any request is
 * served.
 */

import { createApp } from './app.mjs';
import { createAws } from './aws.mjs';
import { loadConfig } from './config.mjs';

const config = loadConfig(process.env);

export const handler = createApp({ aws: createAws(process.env), config });
