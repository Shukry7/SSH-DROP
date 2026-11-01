export class TransferFailure extends Error {}

// A timed-out operation may still finish in the OS/server. Callers must treat
// publishing/opening results as uncertain, and never repeat a write automatically.
export function transferWait<T>(
  start: (callback: (error?: Error | null, value?: T) => void) => void,
  milliseconds: number,
  signal?: AbortSignal,
  late?: (value: T) => void,
  timeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => finish(signal?.reason ?? new TransferFailure('Transfer interrupted.'));
    const finish = (error?: Error | null, value?: T) => {
      if (finished) {
        if (!error && value !== undefined) {
          try {
            late?.(value);
          } catch {
            /* A failed late cleanup cannot reopen a settled operation. */
          }
        }
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => {
      finish(new TransferFailure('Transfer request timed out.'));
      timeout?.();
    }, milliseconds);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      start(finish);
    } catch (error) {
      finish(error as Error);
    }
  });
}
