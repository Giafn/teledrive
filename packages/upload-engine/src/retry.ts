export interface FloodWaitLike {
  code?: string | number;
  message?: string;
  errorMessage?: string;
  seconds?: number;
  floodWaitSeconds?: number;
  waitSeconds?: number;
  retryAfterSeconds?: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<
  Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio'>
> = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

export function getFloodWaitSeconds(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as FloodWaitLike;
  const explicit = [value.floodWaitSeconds, value.waitSeconds, value.retryAfterSeconds, value.seconds].find(
    (seconds) => typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0,
  );
  if (explicit !== undefined) return explicit;

  const message = [value.message, value.errorMessage, typeof value.code === 'string' ? value.code : undefined]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const match = message.match(/FLOOD_WAIT_(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export function retryDelayMs(
  attempt: number,
  error?: unknown,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'random'> = {},
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('retry attempt must be a positive integer');
  }

  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs;
  const jitterRatio = options.jitterRatio ?? DEFAULT_RETRY_OPTIONS.jitterRatio;
  const random = options.random ?? Math.random;
  if (baseDelayMs < 0 || maxDelayMs < 0 || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError('invalid retry delay options');
  }

  const floodWaitSeconds = getFloodWaitSeconds(error);
  if (floodWaitSeconds !== undefined) {
    // Telegram's server-provided wait is a floor, never a best-effort hint.
    return Math.ceil(floodWaitSeconds * 1000);
  }

  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(maxDelayMs, exponential + jitter)));
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let attempt = 1;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || options.shouldRetry?.(error, attempt) === false) {
        throw error;
      }
      await sleep(retryDelayMs(attempt, error, options));
      attempt += 1;
    }
  }
}
