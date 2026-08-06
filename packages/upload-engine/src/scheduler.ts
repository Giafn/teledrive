import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '@teledrive/contracts';

export type SchedulerStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export class SchedulerCancelledError extends Error {
  constructor(message = 'upload scheduler cancelled') {
    super(message);
    this.name = 'SchedulerCancelledError';
  }
}

export interface SchedulerOptions {
  concurrency?: number;
  onStatusChange?: (status: SchedulerStatus) => void;
}

export type SchedulerWorker<T, R> = (task: T, index: number, signal: AbortSignal) => Promise<R>;

export class BoundedScheduler<T, R> {
  private readonly tasks: readonly T[];
  private readonly worker: SchedulerWorker<T, R>;
  private readonly onStatusChange?: (status: SchedulerStatus) => void;
  private _concurrency: number;
  private nextIndex = 0;
  private active = 0;
  private results: R[] = [];
  private controllers = new Set<AbortController>();
  private completion: Promise<readonly R[]> | undefined;
  private resolveCompletion: ((results: readonly R[]) => void) | undefined;
  private rejectCompletion: ((error: unknown) => void) | undefined;
  private _status: SchedulerStatus = 'idle';
  private cancellationError: SchedulerCancelledError | undefined;

  constructor(tasks: readonly T[], worker: SchedulerWorker<T, R>, options: SchedulerOptions = {}) {
    this.tasks = tasks;
    this.worker = worker;
    this.onStatusChange = options.onStatusChange;
    this._concurrency = validateConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
    this.results = new Array<R>(tasks.length);
  }

  get status(): SchedulerStatus {
    return this._status;
  }

  get concurrency(): number {
    return this._concurrency;
  }

  get activeCount(): number {
    return this.active;
  }

  setConcurrency(value: number): void {
    this._concurrency = validateConcurrency(value);
    if (this._status === 'running') this.pump();
  }

  start(): Promise<readonly R[]> {
    if (this.completion) return this.completion;
    this.completion = new Promise<readonly R[]>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    if (this._status === 'cancelled') {
      this.rejectCompletion?.(this.cancellationError ?? new SchedulerCancelledError());
    } else if (this.tasks.length === 0) {
      this.setStatus('completed');
      this.resolveCompletion?.([]);
    } else if (this._status !== 'paused') {
      this.setStatus('running');
      this.pump();
    }
    return this.completion;
  }

  pause(): void {
    if (this._status === 'idle') {
      this.setStatus('paused');
    } else if (this._status === 'running') {
      this.setStatus('paused');
    }
  }

  resume(): void {
    if (this._status === 'paused') {
      this.setStatus('running');
      this.pump();
    }
  }

  cancel(reason?: string): void {
    if (this._status === 'completed' || this._status === 'cancelled' || this._status === 'failed') return;
    this.cancellationError = new SchedulerCancelledError(reason);
    this.setStatus('cancelled');
    for (const controller of this.controllers) controller.abort(this.cancellationError);
    this.rejectCompletion?.(this.cancellationError);
  }

  private pump(): void {
    while (this._status === 'running' && this.active < this._concurrency && this.nextIndex < this.tasks.length) {
      const index = this.nextIndex++;
      this.active += 1;
      const controller = new AbortController();
      this.controllers.add(controller);
      void this.runTask(this.tasks[index], index, controller);
    }

    if (this._status === 'running' && this.nextIndex === this.tasks.length && this.active === 0) {
      this.setStatus('completed');
      this.resolveCompletion?.(this.results);
    }
  }

  private async runTask(task: T, index: number, controller: AbortController): Promise<void> {
    try {
      this.results[index] = await this.worker(task, index, controller.signal);
      this.active -= 1;
      this.controllers.delete(controller);
      this.pump();
    } catch (error) {
      this.active -= 1;
      this.controllers.delete(controller);
      if (this._status === 'cancelled' || this.cancellationError) return;
      this.setStatus('failed');
      for (const activeController of this.controllers) activeController.abort(error);
      this.rejectCompletion?.(error);
    }
  }

  private setStatus(status: SchedulerStatus): void {
    this._status = status;
    this.onStatusChange?.(status);
  }
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new RangeError(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  return value;
}
