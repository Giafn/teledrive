export const MAX_ACTIVE_UPLOADS = 2;

type QueueTask = {
  id: string;
  run: () => Promise<void>;
  onQueued: (position: number) => void;
};

const pending: QueueTask[] = [];
let activeCount = 0;
let floodGateUntil = 0;

function pump(): void {
  while (activeCount < MAX_ACTIVE_UPLOADS && pending.length > 0) {
    if (Date.now() < floodGateUntil) break;
    const task = pending.shift();
    if (!task) break;
    activeCount += 1;
    pending.forEach((queued, index) => queued.onQueued(index + 1));
    void task
      .run()
      .catch(() => undefined)
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
        pump();
      });
  }
}

export function enqueueUpload(task: Omit<QueueTask, 'onQueued'> & { onQueued?: QueueTask['onQueued'] }): () => void {
  const full: QueueTask = { ...task, onQueued: task.onQueued ?? (() => undefined) };
  if (activeCount < MAX_ACTIVE_UPLOADS && pending.length === 0 && Date.now() >= floodGateUntil) {
    activeCount += 1;
    full.onQueued(0);
    void full
      .run()
      .catch(() => undefined)
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
        pump();
      });
  } else {
    pending.push(full);
    full.onQueued(pending.length);
  }
  return () => {
    const index = pending.findIndex((queued) => queued.id === full.id);
    if (index >= 0) {
      pending.splice(index, 1);
      pending.forEach((queued, position) => queued.onQueued(position + 1));
      pump();
    }
  };
}

export function notifyFloodWait(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  floodGateUntil = Math.max(floodGateUntil, Date.now() + seconds * 1000);
}

export function queueStatus(): { active: number; queued: number } {
  return { active: activeCount, queued: pending.length };
}

export function resetUploadQueue(): void {
  pending.length = 0;
  activeCount = 0;
  floodGateUntil = 0;
}
