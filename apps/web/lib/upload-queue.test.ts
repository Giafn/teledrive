import { describe, expect, it, vi } from 'vitest';
import { enqueueUpload, notifyFloodWait, queueStatus, resetUploadQueue } from './upload-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('upload-queue', () => {
  it('runs at most two uploads concurrently and drains the queue', async () => {
    resetUploadQueue();
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: string[] = [];
    const positions: number[] = [];
    const runs = gates.map((gate, index) =>
      enqueueUpload({
        id: `f${index}`,
        run: async () => {
          started.push(`f${index}`);
          await gate.promise;
        },
        onQueued: (position) => positions.push(position),
      }),
    );
    expect(queueStatus()).toEqual({ active: 2, queued: 2 });
    expect(started).toEqual(['f0', 'f1']);

    gates[0].resolve();
    await vi.waitFor(() => expect(started).toEqual(['f0', 'f1', 'f2']));
    gates[1].resolve();
    await vi.waitFor(() => expect(started).toEqual(['f0', 'f1', 'f2', 'f3']));
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(runs.map((_, index) => gates[index].promise));
    await vi.waitFor(() => expect(queueStatus()).toEqual({ active: 0, queued: 0 }));
  });

  it('holds queued uploads behind the flood gate', async () => {
    resetUploadQueue();
    notifyFloodWait(60);
    let ran = false;
    enqueueUpload({ id: 'flood', run: async () => void (ran = true) });
    expect(queueStatus()).toEqual({ active: 0, queued: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(false);
    resetUploadQueue();
  });

  it('removes cancelled queued uploads', () => {
    resetUploadQueue();
    const gate = deferred();
    enqueueUpload({ id: 'active', run: () => gate.promise });
    enqueueUpload({ id: 'active2', run: () => gate.promise });
    const dequeue = enqueueUpload({ id: 'queued', run: async () => undefined });
    expect(queueStatus()).toEqual({ active: 2, queued: 1 });
    dequeue();
    expect(queueStatus()).toEqual({ active: 2, queued: 0 });
    gate.resolve();
    resetUploadQueue();
  });
});
