import { ModelError, RetryableModelError } from './types.ts';

export interface RetryOptions {
  maxRetries: number;
  onRetry?: (attempt: number, delayMs: number, error: RetryableModelError) => void;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

const sleep = (delayMs: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, delayMs));

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof RetryableModelError) || attempt >= options.maxRetries) throw error;
      const fallback = Math.min(500 * 2 ** attempt, 8000) * (0.75 + 0.25 * (options.random ?? Math.random)());
      const delayMs = error.retryAfterMs ?? fallback;
      if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) {
        throw new ModelError(`${error.message}; server retry delay exceeds 60 seconds`);
      }
      options.onRetry?.(attempt + 1, delayMs, error);
      await (options.sleep ?? sleep)(delayMs);
    }
  }
}
