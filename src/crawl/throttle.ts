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
export function concurrencyOptions(overrides?: { maxConcurrency?: number }) {
  const egress = process.env.EGRESS_MODE ?? 'off';
  const defaultMax = egress === 'proxy' ? 4 : egress === 'mesh' ? 8 : 8;
  const minConcurrency = Number(process.env.MIN_CONCURRENCY ?? 1);
  const fromEnv = Number(process.env.MAX_CONCURRENCY ?? defaultMax);
  const fromOverride = overrides?.maxConcurrency;
  const maxRaw =
    fromOverride != null && Number.isFinite(fromOverride) ? fromOverride : fromEnv;
  const maxConcurrency = Math.max(1, Math.min(32, Math.floor(maxRaw)));
  const min = Number.isFinite(minConcurrency) ? Math.max(1, minConcurrency) : 1;
  return {
    minConcurrency: Math.min(min, maxConcurrency),
    maxConcurrency,
    autoscaledPoolOptions: {
      desiredConcurrencyRatio: 0.9,
      scaleUpStepRatio: 0.05,
      scaleDownStepRatio: 0.1,
    },
  };
}
