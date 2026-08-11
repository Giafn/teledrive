import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, TrashItem } from './api';
import { logoutAfterSuccess, permanentlyDeleteTrashItem, restoreTrashItem, trashActionAvailability } from './ui-actions';

const folder: TrashItem = {
  type: 'folder', workspaceId: 'workspace-1', id: 'folder-1', parentId: null, name: 'Folder',
  deletedAt: '2099-01-01', createdAt: '2099-01-01', updatedAt: '2099-01-01', canPermanentlyDelete: true,
};
const object: TrashItem = {
  type: 'object', workspaceId: 'workspace-1', id: 'object-1', folderId: 'folder-1', name: 'file.txt',
  mime: 'text/plain', size: 3, deletedAt: '2099-01-01', createdAt: '2099-01-01', updatedAt: '2099-01-01', canPermanentlyDelete: false,
};

describe('UI action regressions', () => {
  it('keeps session on logout failure and clears state/error only after success', async () => {
    const clearSession = vi.fn();
    const clearError = vi.fn();
    const showError = vi.fn();
    const client = { logout: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true }) };

    await expect(logoutAfterSuccess(client, clearSession, clearError, showError)).resolves.toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(expect.any(Error));
    await expect(logoutAfterSuccess(client, clearSession, clearError, showError)).resolves.toBe(true);
    expect(clearSession).toHaveBeenCalledOnce();
    expect(clearError).toHaveBeenCalledOnce();
  });

  it('restores folder and object through matching routes', async () => {
    const client = {
      restoreFolder: vi.fn().mockResolvedValue({ ok: true }),
      restoreObject: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as ApiClient;
    await restoreTrashItem(client, folder);
    await restoreTrashItem(client, object);
    expect(client.restoreFolder).toHaveBeenCalledWith('folder-1');
    expect(client.restoreObject).toHaveBeenCalledWith('object-1');
  });

  it('exposes permanent action only when backend allows it', async () => {
    const client = {
      permanentDeleteFolder: vi.fn().mockResolvedValue({ ok: true }),
      permanentDeleteObject: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as ApiClient;
    expect(trashActionAvailability(folder).permanentlyDelete).toBe(true);
    expect(trashActionAvailability(object).permanentlyDelete).toBe(false);
    await permanentlyDeleteTrashItem(client, folder);
    expect(client.permanentDeleteFolder).toHaveBeenCalledWith('folder-1');
  });
});
