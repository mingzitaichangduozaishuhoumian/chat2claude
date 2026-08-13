import { Hono } from 'hono';
export const healthRoute = new Hono().get('/healthz', (c) => c.json({ ok: true }));
