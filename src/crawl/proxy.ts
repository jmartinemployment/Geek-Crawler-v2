import { ProxyConfiguration } from 'crawlee';

/**
 * EGRESS_MODE:
 * - off   → direct (Phase 1 default)
 * - proxy → PROXY_URL (Phase 4 ngrok/SOCKS)
 * - mesh  → no ProxyConfiguration; Tailscale exit node (Phase 5)
 */
export function buildProxyConfiguration(): ProxyConfiguration | undefined {
  const mode = process.env.EGRESS_MODE ?? 'off';
  if (mode === 'off' || mode === 'mesh') return undefined;

  const url = process.env.PROXY_URL;
  if (!url) throw new Error('EGRESS_MODE=proxy requires PROXY_URL');
  return new ProxyConfiguration({ proxyUrls: [url] });
}
