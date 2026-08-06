import { base64url } from './security';

export const TRASH_RETENTION_DAYS = 30;

export interface MetadataCursor {
  sortAt: string;
  secondaryAt?: string;
  kind: string;
  id: string;
}

export function encodeMetadataCursor(cursor: MetadataCursor): string {
  return base64url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeMetadataCursor(value: string | undefined): MetadataCursor | undefined {
  if (!value) return undefined;
  try {
    const normalized = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0))),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const cursor = parsed as Record<string, unknown>;
    if (typeof cursor.sortAt !== 'string' || typeof cursor.kind !== 'string' || typeof cursor.id !== 'string')
      return undefined;
    if (cursor.sortAt.length > 64 || cursor.kind.length > 32 || cursor.id.length > 128) return undefined;
    if (cursor.secondaryAt !== undefined && (typeof cursor.secondaryAt !== 'string' || cursor.secondaryAt.length > 64))
      return undefined;
    return {
      sortAt: cursor.sortAt,
      secondaryAt: cursor.secondaryAt as string | undefined,
      kind: cursor.kind,
      id: cursor.id,
    };
  } catch {
    return undefined;
  }
}

export function retentionUntil(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + TRASH_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
}

export function canEditObject(
  ownerMatches: boolean,
  status: string,
  deletedAt: string | null,
  folderActive: boolean,
  folderWorkspaceMatches: boolean,
): boolean {
  return ownerMatches && status === 'completed' && deletedAt === null && folderActive && folderWorkspaceMatches;
}

export function compareRecentMetadata(
  left: { updatedAt: string; createdAt: string; id: string },
  right: { updatedAt: string; createdAt: string; id: string },
): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
