import { describe, expect, it, vi } from 'vitest';

import { SaveQueue } from './saveQueue';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled microtask (the `.then`/`.catch`/`.finally`
 * chain `SaveQueue` builds) actually run before the next assertion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SaveQueue', () => {
  it('runs a push immediately when the queue is idle', () => {
    const d = deferred<void>();
    const save = vi.fn(() => d.promise);
    const queue = new SaveQueue<string>(save, vi.fn());

    queue.push('a');

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('a');
    expect(queue.isSaving).toBe(true);
  });

  it('queues a push made while a save is in flight, rather than starting a second save', () => {
    const d = deferred<void>();
    const save = vi.fn(() => d.promise);
    const queue = new SaveQueue<string>(save, vi.fn());

    queue.push('a');
    queue.push('b');

    // Never two concurrent saves: the second push did not call `save` again.
    expect(save).toHaveBeenCalledTimes(1);
    expect(queue.hasQueued).toBe(true);
  });

  it('flushes the queued change once the in-flight save completes', async () => {
    const first = deferred<void>();
    let secondResolve: (() => void) | null = null;
    const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => {
      return new Promise<void>((resolve) => {
        secondResolve = resolve;
      });
    });
    const queue = new SaveQueue<string>(save, vi.fn());

    queue.push('a');
    queue.push('b');
    first.resolve();
    await flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, 'b');
    expect(queue.hasQueued).toBe(false);
    expect(queue.isSaving).toBe(true);

    secondResolve!();
    await flush();
    expect(queue.isSaving).toBe(false);
  });

  it('coalesces several pushes made while a save is in flight into only the latest', async () => {
    const first = deferred<void>();
    const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(() => Promise.resolve());
    const queue = new SaveQueue<string>(save, vi.fn());

    queue.push('a');
    queue.push('b');
    queue.push('c');
    queue.push('d');
    first.resolve();
    await flush();

    // Only the latest queued value is ever sent — 'b' and 'c' are never
    // pushed to the server, only the state the document is actually in now.
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, 'a');
    expect(save).toHaveBeenNthCalledWith(2, 'd');
  });

  it('does nothing further once a save completes with nothing queued', async () => {
    const d = deferred<void>();
    const save = vi.fn(() => d.promise);
    const queue = new SaveQueue<string>(save, vi.fn());

    queue.push('a');
    d.resolve();
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(queue.isSaving).toBe(false);
    expect(queue.hasQueued).toBe(false);
  });

  it('reports a refusal without stopping the queue, and still flushes what is queued', async () => {
    const first = deferred<void>();
    const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(() => Promise.resolve());
    const onRefusal = vi.fn();
    const queue = new SaveQueue<string>(save, onRefusal);

    queue.push('a');
    queue.push('b');
    const refusal = new Error('refused');
    first.reject(refusal);
    await flush();

    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(onRefusal).toHaveBeenCalledWith(refusal, 'a');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, 'b');
  });

  it('runs a push made after the queue has gone idle again immediately, not queued', async () => {
    const d = deferred<void>();
    const save = vi.fn(() => d.promise);
    const queue = new SaveQueue<string>(save, vi.fn());

    queue.push('a');
    d.resolve();
    await flush();

    queue.push('b');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, 'b');
  });
});
