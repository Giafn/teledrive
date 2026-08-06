import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';
import { api, type ApiClient, type AuthResponse } from './api';

function requireBrowser(): void {
  if (typeof window === 'undefined' || !navigator.credentials) {
    throw new Error('Passkeys require a browser with WebAuthn support.');
  }
}

/** Bootstrap token is forwarded once and never retained by this module. */
export async function registerPasskey(
  userName: string,
  displayName?: string,
  bootstrapToken?: string,
  client: ApiClient = api,
): Promise<AuthResponse> {
  requireBrowser();
  const { startRegistration } = await import('@simplewebauthn/browser');
  const options = await client.registerPasskeyOptions(userName, displayName, bootstrapToken);
  const response: RegistrationResponseJSON = await startRegistration({ optionsJSON: options.options });
  return client.registerPasskeyVerify(options.challengeId, response, bootstrapToken);
}

export async function authenticatePasskey(userName: string, client: ApiClient = api): Promise<AuthResponse> {
  requireBrowser();
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const options = await client.authenticatePasskeyOptions(userName);
  const response: AuthenticationResponseJSON = await startAuthentication({ optionsJSON: options.options });
  return client.authenticatePasskeyVerify(options.challengeId, response);
}
