import { Hono } from 'hono';
import type { RequestLog } from '../services/request-log.js';
export function createMetricsRoute(requestLog: RequestLog): Hono { return new Hono().get('/metrics', (c) => c.json({ requests: requestLog.list().length })); }
