export type FileReferenceIdentity = Readonly<{
  channelId: string;
  messageId: string;
  documentId: string;
}>;

export type FileReferenceObservation = Readonly<{
  identity: FileReferenceIdentity;
  freshness: 'fresh' | 'expired';
  refreshCount: number;
}>;

export type FileReferenceDecision =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'refresh-once' }>
  | Readonly<{ kind: 'rejected'; reason: 'identity-mismatch' | 'repeated-expiry' }>;

function sameIdentity(left: FileReferenceIdentity, right: FileReferenceIdentity): boolean {
  return left.channelId === right.channelId && left.messageId === right.messageId && left.documentId === right.documentId;
}

export function evaluateFileReference(
  expected: FileReferenceIdentity,
  observation: FileReferenceObservation,
): FileReferenceDecision {
  if (!sameIdentity(expected, observation.identity)) return Object.freeze({ kind: 'rejected', reason: 'identity-mismatch' });
  if (observation.freshness === 'fresh') return Object.freeze({ kind: 'accepted' });
  if (observation.refreshCount >= 1) return Object.freeze({ kind: 'rejected', reason: 'repeated-expiry' });
  return Object.freeze({ kind: 'refresh-once' });
}
