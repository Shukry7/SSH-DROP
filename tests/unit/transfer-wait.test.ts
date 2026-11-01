import { afterEach, expect, it, vi } from 'vitest';
import { transferWait } from '../../src/main/core/transfer-wait';

afterEach(() => vi.useRealTimers());
it('settles successful and failed callbacks and synchronous exceptions', async () => {
  await expect(transferWait<number>((cb) => cb(undefined, 3), 100)).resolves.toBe(3);
  await expect(transferWait((cb) => cb(new Error('failure')), 100)).rejects.toThrow('failure');
  await expect(
    transferWait(() => {
      throw new Error('closed');
    }, 100),
  ).rejects.toThrow('closed');
});
it('bounds missing callbacks, runs timeout once, and handles late resources', async () => {
  vi.useFakeTimers();
  let reply!: (error?: Error, handle?: string) => void;
  const late = vi.fn();
  const timeout = vi.fn();
  const pending = expect(
    transferWait<string>(
      (cb) => {
        reply = cb;
      },
      20,
      undefined,
      late,
      timeout,
    ),
  ).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(21);
  await pending;
  reply(undefined, 'late handle');
  expect(late).toHaveBeenCalledWith('late handle');
  late.mockImplementationOnce(() => {
    throw new Error('late resource already closed');
  });
  expect(() => reply(undefined, 'another handle')).not.toThrow();
  expect(timeout).toHaveBeenCalledOnce();
});
it('does not start pre-aborted operations and promptly rejects a later abort', async () => {
  const controller = new AbortController();
  const start = vi.fn();
  controller.abort(new Error('cancelled'));
  await expect(transferWait(start, 100, controller.signal)).rejects.toThrow('cancelled');
  expect(start).not.toHaveBeenCalled();
  const next = new AbortController();
  const pending = expect(transferWait(() => undefined, 100, next.signal)).rejects.toThrow(
    'disconnect',
  );
  next.abort(new Error('disconnect'));
  await pending;
});
