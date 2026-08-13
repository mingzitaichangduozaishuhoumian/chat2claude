import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
const env = loadEnv();
serve({ fetch: createApp(env).fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`chatgpt-to-claude api listening on http://${info.address}:${info.port}`);
});
