export interface TelegramLogicalPart {
  channelId: string;
  partNo: number;
  totalParts: number;
  fileName: string;
  mimeType: string;
  bytes: Readonly<Uint8Array>;
  idempotencyKey: string;
}

export interface TelegramPartReference {
  channelId: string;
  messageId: string;
}

export interface TelegramPartReceipt extends TelegramPartReference {
  partNo: number;
  size: number;
}

/** Browser-side adapter boundary. Implementations must use MTProto directly from browser. */
export interface TelegramGateway {
  uploadLogicalPart(input: TelegramLogicalPart): Promise<TelegramPartReceipt>;
  downloadLogicalPart(reference: TelegramPartReference): Promise<Uint8Array>;
  deleteLogicalPart(reference: TelegramPartReference): Promise<void>;
}

export interface FakeTelegramUpload {
  receipt: TelegramPartReceipt;
  fileName: string;
  mimeType: string;
  totalParts: number;
  bytes: Uint8Array;
}

/**
 * In-memory deterministic simulation. It does not authenticate with or send data to Telegram.
 */
export class FakeTelegramGateway implements TelegramGateway {
  private readonly uploadsByKey = new Map<string, FakeTelegramUpload>();
  private readonly uploadsByMessage = new Map<string, FakeTelegramUpload>();
  private nextMessageId = 1;

  async uploadLogicalPart(input: TelegramLogicalPart): Promise<TelegramPartReceipt> {
    if (input.partNo < 0 || input.partNo >= input.totalParts) {
      throw new RangeError('part number is outside totalParts');
    }
    const key = `${input.channelId}:${input.idempotencyKey}`;
    const existing = this.uploadsByKey.get(key);
    if (existing) return { ...existing.receipt };

    const bytes = new Uint8Array(input.bytes);
    const receipt: TelegramPartReceipt = {
      channelId: input.channelId,
      messageId: `fake-message-${this.nextMessageId++}`,
      partNo: input.partNo,
      size: bytes.byteLength,
    };
    const upload: FakeTelegramUpload = {
      receipt,
      fileName: input.fileName,
      mimeType: input.mimeType,
      totalParts: input.totalParts,
      bytes,
    };
    this.uploadsByKey.set(key, upload);
    this.uploadsByMessage.set(`${receipt.channelId}:${receipt.messageId}`, upload);
    return { ...receipt };
  }

  async downloadLogicalPart(reference: TelegramPartReference): Promise<Uint8Array> {
    const upload = this.uploadsByMessage.get(`${reference.channelId}:${reference.messageId}`);
    if (!upload) throw new Error('fake Telegram message not found');
    return new Uint8Array(upload.bytes);
  }

  async deleteLogicalPart(reference: TelegramPartReference): Promise<void> {
    const mapKey = `${reference.channelId}:${reference.messageId}`;
    const upload = this.uploadsByMessage.get(mapKey);
    if (!upload) return;
    this.uploadsByMessage.delete(mapKey);
    for (const [key, value] of this.uploadsByKey) {
      if (value === upload) this.uploadsByKey.delete(key);
    }
  }

  listUploads(): FakeTelegramUpload[] {
    return [...this.uploadsByMessage.values()].map((upload) => ({
      ...upload,
      receipt: { ...upload.receipt },
      bytes: new Uint8Array(upload.bytes),
    }));
  }
}
