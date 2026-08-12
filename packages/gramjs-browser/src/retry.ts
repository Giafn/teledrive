export type AttemptIdentity = Readonly<{
  fileId: bigint;
  randomId: bigint;
  filename: string;
  logicalPartIndex: number;
  planId: string;
}>;

export type AttemptSnapshot = Readonly<{
  identity: AttemptIdentity;
  retryCount: number;
  maxRetries: number;
  referenceRefreshCount: number;
}>;

export type RetryFailure =
  | Readonly<{ kind: 'flood-wait'; serverMinimumMs: number }>
  | Readonly<{ kind: 'file-migration' | 'transient' }>
  | Readonly<{ kind: 'random-id-duplicate' }>
  | Readonly<{ kind: 'file-reference-expired' | 'file-reference-invalid' }>
  | Readonly<{ kind: 'auth' | 'permission' | 'integrity' | 'invalid-part' | 'cancellation' }>;

export type RetryDecision =
  | Readonly<{ kind: 'retry'; reason: 'flood-wait' | 'file-migration' | 'transient'; delayMs: number; snapshot: AttemptSnapshot }>
  | Readonly<{ kind: 'reconcile'; reason: 'random-id-duplicate'; snapshot: AttemptSnapshot }>
  | Readonly<{ kind: 'refetch-file-reference'; snapshot: AttemptSnapshot }>
  | Readonly<{
      kind: 'fail';
      reason:
        | 'auth'
        | 'permission'
        | 'integrity'
        | 'invalid-part'
        | 'cancellation'
        | 'file-reference-expired'
        | 'retry-exhausted'
        | 'invalid-failure';
      snapshot: AttemptSnapshot;
    }>;

const MIN_SIGNED_64 = -(2n ** 63n);
const MAX_SIGNED_64 = 2n ** 63n - 1n;

function requiredSigned64(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < MIN_SIGNED_64 || value > MAX_SIGNED_64)
    throw new Error(`${label} must be a signed 64-bit bigint`);
  return value;
}

function requiredRandomFilename(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22,}$/u.test(value))
    throw new Error('random filename must use an extensionless 128-bit-or-greater encoding');
  return value;
}

function requiredIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('logical part index is invalid');
  return value;
}

function requiredOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function createAttemptIdentity(input: {
  fileId: bigint;
  randomId: bigint;
  filename: string;
  logicalPartIndex: number;
  planId: string;
}): AttemptIdentity {
  return Object.freeze({
    fileId: requiredSigned64(input.fileId, 'file id'),
    randomId: requiredSigned64(input.randomId, 'random id'),
    filename: requiredRandomFilename(input.filename),
    logicalPartIndex: requiredIndex(input.logicalPartIndex),
    planId: requiredOpaqueId(input.planId, 'plan id'),
  });
}

export function createAttemptSnapshot(identity: AttemptIdentity, maxRetries: number): AttemptSnapshot {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error('max retries is invalid');
  return Object.freeze({ identity, retryCount: 0, maxRetries, referenceRefreshCount: 0 });
}

function nextSnapshot(
  snapshot: AttemptSnapshot,
  changes: Partial<Pick<AttemptSnapshot, 'retryCount' | 'referenceRefreshCount'>> = {},
) {
  return Object.freeze({
    ...snapshot,
    retryCount: snapshot.retryCount + 1,
    ...changes,
  });
}

function failed(snapshot: AttemptSnapshot, reason: Extract<RetryDecision, { kind: 'fail' }>['reason']): RetryDecision {
  return Object.freeze({ kind: 'fail', reason, snapshot });
}

export function decideRetry(snapshot: AttemptSnapshot, failure: RetryFailure): RetryDecision {
  if (failure.kind === 'flood-wait') {
    if (!Number.isSafeInteger(failure.serverMinimumMs) || failure.serverMinimumMs <= 0) return failed(snapshot, 'invalid-failure');
    if (snapshot.retryCount >= snapshot.maxRetries) return failed(snapshot, 'retry-exhausted');
    return Object.freeze({ kind: 'retry', reason: 'flood-wait', delayMs: failure.serverMinimumMs, snapshot: nextSnapshot(snapshot) });
  }
  if (failure.kind === 'file-migration' || failure.kind === 'transient') {
    if (snapshot.retryCount >= snapshot.maxRetries) return failed(snapshot, 'retry-exhausted');
    return Object.freeze({ kind: 'retry', reason: failure.kind, delayMs: 0, snapshot: nextSnapshot(snapshot) });
  }
  if (failure.kind === 'random-id-duplicate') return Object.freeze({ kind: 'reconcile', reason: failure.kind, snapshot });
  if (failure.kind === 'file-reference-expired' || failure.kind === 'file-reference-invalid') {
    if (snapshot.referenceRefreshCount >= 1) return failed(snapshot, 'file-reference-expired');
    return Object.freeze({
      kind: 'refetch-file-reference',
      snapshot: nextSnapshot(snapshot, { retryCount: snapshot.retryCount, referenceRefreshCount: snapshot.referenceRefreshCount + 1 }),
    });
  }
  return failed(snapshot, failure.kind);
}
