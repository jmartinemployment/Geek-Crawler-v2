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
