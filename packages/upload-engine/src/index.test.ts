import { describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE } from '@teledrive/contracts';
import {
  BoundedScheduler,
  InvalidUploadTransitionError,
  SchedulerCancelledError,
  UploadStateMachine,
  planChunks,
  retryDelayMs,
  withRetry,
} from './index';

describe('chunk planner', () => {
  it('handles empty, boundary, and final-small chunks', () => {
    expect(planChunks(0)).toEqual([]);
    expect(planChunks(CHUNK_SIZE)).toEqual([{ index: 0, offset: 0, size: CHUNK_SIZE }]);
    expect(planChunks(CHUNK_SIZE + 3)).toEqual([
      { index: 0, offset: 0, size: CHUNK_SIZE },
      { index: 1, offset: CHUNK_SIZE, size: 3 },
    ]);
  });
});

describe('upload state machine', () => {
  it('rejects incomplete verification and illegal transitions', () => {
    const machine = new UploadStateMachine(2);
    machine.transition('uploading');
    machine.commitPart(0);
    expect(() => machine.beginVerification()).toThrow('1 parts missing');
    expect(() => machine.transition('completed')).toThrow(InvalidUploadTransitionError);
    machine.commitPart(1);
    machine.beginVerification();
    machine.complete();
    expect(machine.status).toBe('completed');
    expect(() => machine.commitPart(0)).toThrow(InvalidUploadTransitionError);
  });
});

describe('retry', () => {
  it('honors FLOOD_WAIT and retries with exponential delay', async () => {
    expect(retryDelayMs(1, { message: 'FLOOD_WAIT_7' })).toBe(7000);
    expect(retryDelayMs(2, undefined, { random: () => 0.5, jitterRatio: 0 })).toBe(500);

    const sleeps: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('temporary');
          return 'ok';
        },
        {
          baseDelayMs: 10,
          jitterRatio: 0,
          sleep: async (delay) => {
            sleeps.push(delay);
          },
        },
      ),
    ).resolves.toBe('ok');
    expect(sleeps).toEqual([10, 20]);
  });
});

describe('bounded scheduler', () => {
  it('does not start work beyond concurrency and pauses before backpressure is released', async () => {
    const deferred: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const scheduler = new BoundedScheduler(
      [0, 1, 2, 3],
      async (task) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => deferred.push(resolve));
        active -= 1;
        return task * 2;
      },
      { concurrency: 2 },
    );

    const result = scheduler.start();
    expect(active).toBe(2);
    scheduler.pause();
    deferred.splice(0, 2).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(active).toBe(0));
    expect(scheduler.status).toBe('paused');
    expect(active).toBe(0);
    scheduler.resume();
    expect(active).toBe(2);
    deferred.splice(0, 2).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(active).toBe(0));
    deferred.splice(0, 2).forEach((resolve) => resolve());
    await expect(result).resolves.toEqual([0, 2, 4, 6]);
    expect(peak).toBe(2);
  });

  it('aborts active work on cancellation', async () => {
    let signal: AbortSignal | undefined;
    const scheduler = new BoundedScheduler(
      [1],
      async (_task, _index, taskSignal) => {
        signal = taskSignal;
        await new Promise<void>(() => undefined);
        return 1;
      },
      { concurrency: 1 },
    );
    const result = scheduler.start();
    scheduler.cancel();
    await expect(result).rejects.toBeInstanceOf(SchedulerCancelledError);
    expect(signal?.aborted).toBe(true);
  });
});
