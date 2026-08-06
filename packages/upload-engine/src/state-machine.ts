import type { UploadStatus } from '@teledrive/contracts';
import { assertValidPartNumber } from '@teledrive/contracts';

export const UPLOAD_STATE_TRANSITIONS: Readonly<Record<UploadStatus, readonly UploadStatus[]>> = {
  created: ['uploading', 'aborted'],
  uploading: ['paused', 'verifying', 'failed', 'aborted'],
  paused: ['uploading', 'aborted'],
  verifying: ['completed', 'failed'],
  completed: ['deleted'],
  failed: ['uploading', 'aborted'],
  aborted: [],
  deleted: [],
};

export class InvalidUploadTransitionError extends Error {
  constructor(from: UploadStatus, to: UploadStatus) {
    super(`invalid upload transition: ${from} -> ${to}`);
    this.name = 'InvalidUploadTransitionError';
  }
}

export function canTransitionUpload(from: UploadStatus, to: UploadStatus): boolean {
  return UPLOAD_STATE_TRANSITIONS[from].includes(to);
}

export function transitionUploadState(from: UploadStatus, to: UploadStatus): UploadStatus {
  if (!canTransitionUpload(from, to)) throw new InvalidUploadTransitionError(from, to);
  return to;
}

export interface UploadStateSnapshot {
  status: UploadStatus;
  partCount: number;
  committedParts: readonly number[];
}

export class UploadStateMachine {
  private current: UploadStatus = 'created';
  private readonly committed = new Set<number>();

  constructor(
    private readonly partCount: number,
    committedParts: Iterable<number> = [],
  ) {
    if (!Number.isSafeInteger(partCount) || partCount < 0) {
      throw new RangeError('part count must be a non-negative safe integer');
    }
    for (const partNo of committedParts) {
      assertValidPartNumber(partNo, this.partCount);
      this.committed.add(partNo);
    }
  }

  get status(): UploadStatus {
    return this.current;
  }

  get committedPartCount(): number {
    return this.committed.size;
  }

  hasAllParts(): boolean {
    return this.committed.size === this.partCount;
  }

  hasPart(partNo: number): boolean {
    return this.committed.has(partNo);
  }

  transition(next: UploadStatus): void {
    if (next === 'verifying' && !this.hasAllParts()) {
      throw new Error(`cannot verify upload: ${this.partCount - this.committed.size} parts missing`);
    }
    this.current = transitionUploadState(this.current, next);
  }

  commitPart(partNo: number): void {
    assertValidPartNumber(partNo, this.partCount);
    if (this.current !== 'uploading') {
      throw new InvalidUploadTransitionError(this.current, 'uploading');
    }
    this.committed.add(partNo);
  }

  beginVerification(): void {
    if (!this.hasAllParts()) {
      throw new Error(`cannot verify upload: ${this.partCount - this.committed.size} parts missing`);
    }
    this.transition('verifying');
  }

  complete(): void {
    if (this.current !== 'verifying') {
      throw new InvalidUploadTransitionError(this.current, 'completed');
    }
    this.transition('completed');
  }

  snapshot(): UploadStateSnapshot {
    return {
      status: this.current,
      partCount: this.partCount,
      committedParts: [...this.committed].sort((a, b) => a - b),
    };
  }
}
