import { expect, it, vi } from 'vitest';

const telegramMock = vi.hoisted(() => {
  const events: string[] = [];

  class FakeLogOut {}

  class FakeUser {
    id = 1;
  }

  class FakeCustomFile {
    constructor(
      readonly name: string,
      readonly size: number,
      readonly path: string,
      readonly buffer: unknown,
    ) {}
  }

  class FakeStringSession {
    save() {
      return '';
    }
  }

  class FakeClient {
    static options: unknown;

    constructor(...args: unknown[]) {
      FakeClient.options = args[3];
    }

    async start() {
      events.push('start');
    }

    async getMe() {
      events.push('getMe');
      throw new Error('getMe failed');
    }

    async invoke(request: unknown) {
      expect(request).toBeInstanceOf(FakeLogOut);
      events.push('logout');
    }

    async disconnect() {
      events.push('disconnect');
    }
  }

  return {
    events,
    FakeClient,
    FakeCustomFile,
    FakeLogOut,
    runtime: {
      TelegramClient: FakeClient,
      sessions: { StringSession: FakeStringSession },
      extensions: { PromisedWebSockets: class FakeWebSockets {} },
      Api: {
        Channel: class FakeChannel {},
        User: FakeUser,
        DocumentAttributeFilename: class FakeFilename {},
        auth: { LogOut: FakeLogOut },
      },
    },
    uploads: { CustomFile: FakeCustomFile },
  };
});

vi.mock('telegram', () => telegramMock.runtime);
vi.mock('telegram/client/uploads', () => telegramMock.uploads);

it('fails closed when loaded outside browser client runtime', async () => {
  const { createMtprotoSpikeAdapter } = await import('./mtproto-spike');
  const adapter = createMtprotoSpikeAdapter({ apiId: 1, apiHash: 'test' });

  await expect(adapter.authenticate()).rejects.toThrow('browser client runtime');
});

it('clears module adapter after authentication failure', async () => {
  const module = await import('./mtproto-spike');
  module.connect({ apiId: 1, apiHash: 'test' });

  await expect(module.login()).rejects.toThrow('browser client runtime');
  expect(() => module.connect({ apiId: 1, apiHash: 'test' })).not.toThrow();
  await module.disconnect();
});

it('logs out before disconnecting after authenticated adapter failure', async () => {
  const module = await import('./mtproto-spike');
  const adapter = module.createMtprotoSpikeAdapter({ apiId: 1, apiHash: 'test' });
  const events: string[] = [];
  const client = {
    invoke: vi.fn(async () => events.push('logout')),
    disconnect: vi.fn(async () => events.push('disconnect')),
  };
  class FakeLogOut {}
  Object.assign(adapter as unknown as Record<string, unknown>, {
    client,
    runtime: { Api: { auth: { LogOut: FakeLogOut } } },
  });

  expect(await adapter.logout()).toBe(true);
  expect(client.invoke).toHaveBeenCalledBefore(client.disconnect);
  expect(events).toEqual(['logout', 'disconnect']);
});

it('logs out before resetting shared adapter after post-auth dialog failure', async () => {
  const module = await import('./mtproto-spike');
  const adapter = module.connect({ apiId: 1, apiHash: 'test' });
  telegramMock.events.length = 0;
  const client = {
    invoke: vi.fn(async () => telegramMock.events.push('logout')),
    disconnect: vi.fn(async () => telegramMock.events.push('disconnect')),
  };
  Object.assign(adapter as unknown as Record<string, unknown>, {
    client,
    runtime: { Api: { auth: { LogOut: telegramMock.FakeLogOut } } },
  });

  await expect(module.listPrivateDialogs()).rejects.toThrow('browser client runtime');
  expect(telegramMock.events).toEqual(['logout', 'disconnect']);
  expect(() => module.connect({ apiId: 1, apiHash: 'test' })).not.toThrow();
  await module.disconnect();
});

it('preserves download failure after logout, disconnect, and shared reset', async () => {
  const module = await import('./mtproto-spike');
  const adapter = module.connect({ apiId: 1, apiHash: 'test' });
  const events: string[] = [];
  const client = {
    invoke: vi.fn(async () => events.push('logout')),
    disconnect: vi.fn(async () => events.push('disconnect')),
  };
  class FakeLogOut {}
  Object.assign(adapter as unknown as Record<string, unknown>, {
    client,
    runtime: { Api: { auth: { LogOut: FakeLogOut } } },
  });
  const originalError = new Error('download hash mismatch');
  vi.spyOn(adapter, 'downloadAndVerify').mockRejectedValue(originalError);

  await expect(
    module.downloadFile({
      channelId: 'channel',
      messageId: 1,
      documentId: 'document',
      fileName: 'file.bin',
      mimeType: 'application/octet-stream',
      size: 1,
      sha256: 'hash',
    }),
  ).rejects.toBe(originalError);
  expect(client.invoke).toHaveBeenCalledBefore(client.disconnect);
  expect(events).toEqual(['logout', 'disconnect']);
  expect(() => module.connect({ apiId: 1, apiHash: 'test' })).not.toThrow();
  await module.disconnect();
});

it('converts browser File to in-memory GramJS CustomFile before upload', async () => {
  const module = await import('./mtproto-spike');
  const restore = new Map<string, PropertyDescriptor | undefined>();
  const browserGlobals = {
    window: { prompt: () => 'test' },
    WebSocket: class FakeWebSocket {},
    File: class FakeFile {
      readonly name: string;
      readonly size: number;

      constructor(
        name: string,
        private readonly bytes: Uint8Array,
      ) {
        this.name = name;
        this.size = bytes.byteLength;
      }

      async arrayBuffer() {
        return this.bytes.slice().buffer;
      }
    },
  };
  for (const [name, value] of Object.entries(browserGlobals)) {
    restore.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }

  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sent: { file?: unknown } = {};
  const adapter = module.createMtprotoSpikeAdapter({ apiId: 1, apiHash: 'test' });
  Object.assign(adapter as unknown as Record<string, unknown>, {
    client: {
      sendFile: vi.fn(async (_entity: unknown, options: { file: unknown }) => {
        sent.file = options.file;
        return {
          id: 1,
          document: {
            id: 2,
            size: bytes.byteLength,
            mimeType: 'application/octet-stream',
            attributes: [],
          },
        };
      }),
    },
    runtime: { Api: { DocumentAttributeFilename: class FakeFilename {} } },
    selectedChannel: {
      channel: { id: 'channel' },
      inputEntity: {},
    },
  });

  try {
    const file = new browserGlobals.File('source.bin', bytes);
    await adapter.sendDocument(file as unknown as File);
    expect(sent.file).toBeInstanceOf(telegramMock.FakeCustomFile);
    expect(sent.file).toMatchObject({
      name: 'source.bin',
      size: bytes.byteLength,
      path: '',
    });
    expect(Array.from((sent.file as { buffer: ArrayLike<number> }).buffer)).toEqual(
      Array.from(bytes),
    );
  } finally {
    for (const [name, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

it('logs out before disconnecting when login fails after authorization', async () => {
  const module = await import('./mtproto-spike');
  const restore = new Map<string, PropertyDescriptor | undefined>();
  const browserGlobals = {
    window: { prompt: () => 'test' },
    WebSocket: class FakeWebSocket {},
    File: class FakeFile {
      async arrayBuffer() {
        return new ArrayBuffer(0);
      }
    },
  };
  for (const [name, value] of Object.entries(browserGlobals)) {
    restore.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  telegramMock.events.length = 0;
  const adapter = module.connect({ apiId: 1, apiHash: 'test' });

  try {
    await expect(module.login()).rejects.toThrow('Telegram authentication failed: getMe failed');
    expect(telegramMock.FakeClient.options).toMatchObject({
      requestRetries: 2,
      connectionRetries: 1,
      reconnectRetries: 1,
    });
    expect(telegramMock.events).toEqual(['start', 'getMe', 'logout', 'disconnect']);
    expect(() => module.connect({ apiId: 1, apiHash: 'test' })).not.toThrow();
  } finally {
    await module.disconnect();
    void adapter;
    for (const [name, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
