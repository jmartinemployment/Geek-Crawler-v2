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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PersistenceError';
  }
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
