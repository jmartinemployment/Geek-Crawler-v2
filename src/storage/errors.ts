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

/**
 * A transport error with its causes, outermost first.
 *
 * fetch rejects with "fetch failed" and puts the reason in cause: the socket the
 * other side closed, a reset, a refused connection, a DNS miss, a timeout. Keeping
 * only the message left every post-mortem of the 2026-10-05 failures reading
 * "fetch failed", which names no cause at all. Each level contributes its message
 * and its code when it has one; an AggregateError (several addresses tried)
 * contributes each of its errors.
 */
export function describeTransportError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current) && parts.length < 6) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      const message = current.message;
      const label = typeof code === 'string' && !message.includes(code)
        ? (message ? `${message} (${code})` : code)
        : message;
      if (current instanceof AggregateError && current.errors.length > 0) {
        const inner = current.errors.map((e) => describeTransportError(e)).join(' | ');
        parts.push(label ? `${label}: ${inner}` : inner);
      } else if (label) {
        parts.push(label);
      }
      current = current.cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
  }
  return parts.length > 0 ? parts.join('; caused by: ') : String(err);
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
