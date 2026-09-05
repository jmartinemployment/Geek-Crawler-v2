import http from 'node:http';
import https from 'node:https';

/** Shared Keep-Alive agents — reuse TCP/TLS across same-host pages. */
export const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});

export const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});

/** Phase 2 adaptive bounds; residential egress (Phase 4+) should keep max modest. */
export function concurrencyOptions() {
  const egress = process.env.EGRESS_MODE ?? 'off';
  const defaultMax = egress === 'proxy' ? 4 : egress === 'mesh' ? 8 : 8;
  const minConcurrency = Number(process.env.MIN_CONCURRENCY ?? 1);
  const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? defaultMax);
  return {
    minConcurrency: Number.isFinite(minConcurrency) ? Math.max(1, minConcurrency) : 1,
    maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, maxConcurrency) : defaultMax,
    autoscaledPoolOptions: {
      desiredConcurrencyRatio: 0.9,
      scaleUpStepRatio: 0.05,
      scaleDownStepRatio: 0.1,
    },
  };
}
