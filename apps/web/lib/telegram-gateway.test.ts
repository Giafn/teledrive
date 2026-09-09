import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramGateway,
  normalizeTelegramError,
  prepareTelegramUpload,
  reportTelegramError,
  TelegramConfigurationError,
} from './telegram-gateway';

describe('Telegram worker error normalization', () => {
  it('extracts bounded safe fields from structured-cloned errors', () => {
    const error = normalizeTelegramError({
      message: 'Telegram request failed',
      text: 'AUTH_KEY_UNREGISTERED',
      code: 401,
      secret: 'must-not-escape',
      details: { credential: 'must-not-escape' },
    });

    expect(error.message).toBe('Telegram request failed — AUTH_KEY_UNREGISTERED — code 401');
    expect(error.message).not.toContain('must-not-escape');
    expect(error.message).not.toContain('[object Object]');
  });

  it('classifies known configuration messages without exposing reasons', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cases = [
      [
        'Set NEXT_PUBLIC_TELEGRAM_API_ID and NEXT_PUBLIC_TELEGRAM_API_HASH from the Telegram app owner.',
        'WEB_API_CREDENTIALS_MISSING',
      ],
      [
        'NEXT_PUBLIC_TELEGRAM_API_ID and NEXT_PUBLIC_TELEGRAM_API_HASH must be supplied by the Telegram app owner.',
        'WORKER_API_CREDENTIALS_MISSING',
      ],
      [
        'Set NEXT_PUBLIC_TELEGRAM_CHANNEL or pass channel to createTelegramGateway before uploading.',
        'CHANNEL_MISSING',
      ],
      ['Upload byte chunk transfer failed.', 'BYTE_CHUNK_TRANSFER_FAILED'],
      ['Upload part number must be a non-negative integer.', 'INVALID_PART_NUMBER'],
    ] as const;

    try {
      for (const [reason, code] of cases) reportTelegramError('upload', new TelegramConfigurationError(reason));
      expect(errorSpy.mock.calls.map((call) => call[1])).toEqual(
        cases.map(([, code]) => ({ operation: 'upload', category: 'configuration', code })),
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('NEXT_PUBLIC_TELEGRAM_API_HASH');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('byte chunk');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('uses unknown configuration code for unrecognized messages and bounds fields', () => {
    const error = normalizeTelegramError({ message: 'TelegramConfigurationError: missing Telegram API credentials' });
    const oversized = normalizeTelegramError({ message: 'x'.repeat(10_000) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      reportTelegramError('upload', new TelegramConfigurationError('private channel secret: 123'));
      expect(errorSpy).toHaveBeenCalledWith('[teledrive:telegram]', {
        operation: 'upload',
        category: 'configuration',
        code: 'CONFIGURATION_UNKNOWN',
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('private channel secret');
    } finally {
      errorSpy.mockRestore();
    }
    expect(error).toBeInstanceOf(TelegramConfigurationError);
    expect(oversized.message.length).toBeLessThanOrEqual(1024);
  });

  it('reports only safe Telegram code and operation fields', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      reportTelegramError('sendCode', {
        message: 'Telegram API error: API_ID_INVALID',
        text: 'API_ID_INVALID',
        code: 400,
        phone: '+15551234567',
        apiHash: 'secret-api-hash',
        raw: { authKey: 'secret-auth-key' },
      });

      expect(errorSpy).toHaveBeenCalledWith('[teledrive:telegram]', {
        operation: 'sendCode',
        category: 'rpc',
        code: 'API_ID_INVALID',
        reason: 'Telegram API error: API_ID_INVALID — API_ID_INVALID — code 400',
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('+15551234567');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret-api-hash');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret-auth-key');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports pre-invoke configuration failures without logging channel values', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        createTelegramGateway({ channel: 'private-channel-secret' }).uploadPart(new Blob(['x']), 0),
      ).rejects.toBeInstanceOf(TelegramConfigurationError);
      expect(errorSpy).toHaveBeenCalledWith('[teledrive:telegram]', {
        operation: 'upload',
        category: 'configuration',
        code: 'CONFIGURATION_UNKNOWN',
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('private-channel-secret');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('prepares one Uint8Array payload and never includes a Blob', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const prepared = await prepareTelegramUpload(
      new Blob([bytes]),
      'channel-secret',
      0,
      'chunk.bin',
      'application/octet-stream',
    );

    expect(prepared.payload.bytes).toBeInstanceOf(Uint8Array);
    expect([...prepared.payload.bytes]).toEqual([...bytes]);
    expect('file' in prepared.payload).toBe(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      reportTelegramError('upload', new TelegramConfigurationError('Upload byte chunk transfer failed.'));
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('1,2,3,4');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
