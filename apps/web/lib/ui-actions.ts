import type { ApiClient, TrashItem } from './api';

type LogoutClient = Pick<ApiClient, 'logout'>;

export async function logoutAfterSuccess(
  client: LogoutClient,
  clearSession: () => void,
  clearError: () => void,
  showError: (error: unknown) => void,
): Promise<boolean> {
  try {
    await client.logout();
    clearSession();
    clearError();
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

export function requestTelegramAuthorization(
  client: Pick<ApiClient, 'telegramAuthorizationUrl'>,
  mode: 'login' | 'register',
  secretInfo?: string,
) {
  return mode === 'register'
    ? client.telegramAuthorizationUrl('register', secretInfo)
    : client.telegramAuthorizationUrl(mode);
}

export function trashActionAvailability(item: TrashItem) {
  return {
    restore: true,
    permanentlyDelete: item.canPermanentlyDelete,
  };
}

export function restoreTrashItem(client: ApiClient, item: TrashItem) {
  return item.type === 'folder' ? client.restoreFolder(item.id) : client.restoreObject(item.id);
}

export function permanentlyDeleteTrashItem(client: ApiClient, item: TrashItem) {
  return item.type === 'folder' ? client.permanentDeleteFolder(item.id) : client.permanentDeleteObject(item.id);
}
