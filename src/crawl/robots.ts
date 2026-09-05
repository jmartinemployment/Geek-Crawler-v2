import { RobotsTxtFile } from 'crawlee';
import { BOT } from '../bot/identity.js';

/** Per-origin robots.txt cache for the crawl process. */
export function createRobotsGate() {
  const cache = new Map<string, RobotsTxtFile | null>();

  async function load(origin: string): Promise<RobotsTxtFile | null> {
    if (cache.has(origin)) return cache.get(origin) ?? null;
    try {
      const robots = await RobotsTxtFile.find(`${origin}/`);
      cache.set(origin, robots);
      return robots;
    } catch {
      // Fail open on fetch errors (same spirit as many polite crawlers); allow URL.
      cache.set(origin, null);
      return null;
    }
  }

  return {
    async isAllowed(url: string): Promise<boolean> {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return false;
      }
      const robots = await load(origin);
      if (!robots) return true;
      return robots.isAllowed(url, BOT.name) || robots.isAllowed(url, '*');
    },
  };
}

export type RobotsGate = ReturnType<typeof createRobotsGate>;
