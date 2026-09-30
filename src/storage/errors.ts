/** Scoped failure types — do not wrap config/robots as PersistenceError. */

export class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class PersistenceError extends Error {
  readonly code = 'PERSISTENCE_FAILED' as const;

  /**
   * True when the sink could not be reached or did not answer for itself.
   *
   * The distinction decides whether a finished crawl is destroyed. A run that GeekAPI refused --
   * 400 on unusable content, 409 on a stale commit -- is determinately over, and purging is right.
   * A transport failure, a 5xx, or a 404 from a proxy standing in front of a deployment says
   * nothing about the run; the crawl may be perfectly good and the API merely absent.
   *
   * Introduced 2026-09-30 after three finished crawls -- parseur 180 pages, quickbooks 81,
   * zoneandco 342 -- were purged in one minute because Railway answered
   * `404 {"message":"Application not found"}` mid-deploy and every error took the same path.
   */
  readonly unreachable: boolean;

  constructor(message: string, options?: { cause?: unknown; unreachable?: boolean }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PersistenceError';
    this.unreachable = options?.unreachable ?? false;
  }
}

/** Whether a caught error means "the sink was not there", rather than "the sink said no". */
export function isUnreachable(err: unknown): boolean {
  if (err instanceof PersistenceError) return err.unreachable;
  return (err as { unreachable?: boolean })?.unreachable === true;
}

export class RobotsBlockedError extends Error {
  readonly code = 'ROBOTS_BLOCKED' as const;
  readonly origin: string;
  constructor(origin: string, reason: string) {
    super(`robots blocked for ${origin}: ${reason}`);
    this.name = 'RobotsBlockedError';
    this.origin = origin;
  }
}

export function isPersistenceError(err: unknown): err is PersistenceError {
  return err instanceof PersistenceError || (err as { code?: string })?.code === 'PERSISTENCE_FAILED';
}
