const CONFIGURATION_ERROR_PREFIX = 'TelegramConfigurationError: ';

export class TelegramConfigurationError extends Error {
  constructor(reason: string) {
    super(`${CONFIGURATION_ERROR_PREFIX}${reason}`);
    this.name = 'TelegramConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function configurationReason(message: string): string | undefined {
  return message.startsWith(CONFIGURATION_ERROR_PREFIX) ? message.slice(CONFIGURATION_ERROR_PREFIX.length) : undefined;
}
