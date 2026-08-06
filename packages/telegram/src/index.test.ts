import { describe, expect, it } from 'vitest';
import { FakeTelegramGateway } from './index';

describe('fake Telegram gateway', () => {
  it('is deterministic, idempotent, and copies bytes', async () => {
    const gateway = new FakeTelegramGateway();
    const bytes = new Uint8Array([1, 2, 3]);
    const input = {
      channelId: 'channel',
      partNo: 0,
      totalParts: 1,
      fileName: 'file.bin',
      mimeType: 'application/octet-stream',
      bytes,
      idempotencyKey: 'upload-0',
    };
    const first = await gateway.uploadLogicalPart(input);
    bytes[0] = 9;
    const second = await gateway.uploadLogicalPart(input);
    expect(second).toEqual(first);
    await expect(gateway.downloadLogicalPart(first)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(gateway.listUploads()).toHaveLength(1);
  });

  it('does not claim missing messages exist', async () => {
    const gateway = new FakeTelegramGateway();
    await expect(gateway.downloadLogicalPart({ channelId: 'x', messageId: 'missing' })).rejects.toThrow();
  });
});
