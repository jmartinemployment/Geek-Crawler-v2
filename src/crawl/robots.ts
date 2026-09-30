import { RobotsTxtFile } from 'crawlee';
import { BOT } from '../bot/identity.js';
import { RobotsBlockedError } from '../storage/errors.js';

export type RobotsLoadResult =
  | { ok: true; robots: RobotsTxtFile }
  | { ok: false; reason: string };

/** Per-origin robots.txt cache for the crawl process. Fail closed on load errors. */
export function createRobotsGate() {
  const cache = new Map<string, RobotsLoadResult>();

  async function load(origin: string): Promise<RobotsLoadResult> {
    const cached = cache.get(origin);
    if (cached) return cached;
    try {
      const robots = await RobotsTxtFile.find(`${origin}/`);
      if (!robots) {
        const blocked: RobotsLoadResult = { ok: false, reason: 'robots_missing' };
        cache.set(origin, blocked);
        console.error(
          JSON.stringify({ code: 'ROBOTS_BLOCKED', origin, message: 'robots_missing' }),
        );
        return blocked;
      }
      const ok: RobotsLoadResult = { ok: true, robots };
      cache.set(origin, ok);
      return ok;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const blocked: RobotsLoadResult = {
        ok: false,
        reason: `robots_fetch_failed:${detail.slice(0, 200)}`,
      };
      cache.set(origin, blocked);
      console.error(
        JSON.stringify({
          code: 'ROBOTS_BLOCKED',
          origin,
          message: blocked.reason.slice(0, 500),
        }),
      );
      return blocked;
    }
  }

  return {
    /** Fail closed: unavailable robots → do not crawl origin. */
    async requireOrigin(origin: string): Promise<void> {
      const result = await load(origin);
      if (!result.ok) {
        throw new RobotsBlockedError(origin, result.reason);
      }
    },

    /**
     * Refuse a crawl whose own seed robots.txt disallows, before a run exists.
     *
     * taulia.com was crawled four times -- 2026-09-23, then 03:29, 05:50 and 06:01 on 09-30 --
     * walking 202 and then 558 URLs to save zero pages, because every URL on the site is
     * disallowed. The crawl only learned this at the end, where GeekAPI refuses the run with
     * "Crawl reported complete with no usable pages" and the run is purged. One request to
     * robots.txt answers it: `requireOrigin` already fetches the file to fail closed on a missing
     * one, so this costs nothing beyond reading the seed against what it already has.
     *
     * The seed only. A site that disallows some sections is a normal site, and per-URL filtering
     * stays where it is.
     */
    async requireSeedAllowed(seed: string): Promise<void> {
      let origin: string;
      try {
        origin = new URL(seed).origin;
      } catch {
        throw new RobotsBlockedError(seed, 'seed_not_a_url');
      }
      const result = await load(origin);
      if (!result.ok) throw new RobotsBlockedError(origin, result.reason);
      const allowed =
        result.robots.isAllowed(seed, BOT.name) || result.robots.isAllowed(seed, '*');
      if (!allowed) {
        throw new RobotsBlockedError(origin, `seed_disallowed:${seed}`);
      }
    },

    async isAllowed(url: string): Promise<boolean> {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return false;
      }
      const result = await load(origin);
      if (!result.ok) return false;
      return (
        result.robots.isAllowed(url, BOT.name) || result.robots.isAllowed(url, '*')
      );
    },
  };
}

export type RobotsGate = ReturnType<typeof createRobotsGate>;
