import { Hono } from 'hono';
import type { RequestLog } from '../services/request-log.js';
import type { AdminOperationalState } from '../services/admin-operational-state.js';

export interface MetricsRouteOptions {
  requestLog: RequestLog;
  operationalState?: AdminOperationalState;
}

export function createMetricsRoute({ requestLog, operationalState }: MetricsRouteOptions): Hono {
  return new Hono().get('/metrics', (c) => {
    const requestLogSummary = requestLog.summary();
    const accounts = operationalState?.snapshot().accounts ?? [];
    const operational = accounts.reduce((total, account) => ({
      accounts: total.accounts + 1,
      totalRequests: total.totalRequests + account.requestStats.totalRequests,
      successfulRequests: total.successfulRequests + account.requestStats.successfulRequests,
      failedRequests: total.failedRequests + account.requestStats.failedRequests,
      cancelledRequests: total.cancelledRequests + account.requestStats.cancelledRequests,
      inputTokens: total.inputTokens + account.requestStats.inputTokens,
      outputTokens: total.outputTokens + account.requestStats.outputTokens,
      inFlight: total.inFlight + account.requestStats.inFlight,
    }), { accounts: 0, totalRequests: 0, successfulRequests: 0, failedRequests: 0, cancelledRequests: 0, inputTokens: 0, outputTokens: 0, inFlight: 0 });

    return c.json({
      requests: requestLogSummary.retained,
      request_log: requestLogSummary,
      ...(operationalState ? { operational } : {}),
    });
  });
}
