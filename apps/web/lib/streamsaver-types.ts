declare module 'streamsaver' {
  const streamSaver: {
    supported?: boolean;
    mitm: string;
    createWriteStream: (
      filename: string,
      options?: { size?: number },
    ) => {
      getWriter: () => {
        write(data: Uint8Array): Promise<void>;
        close(): Promise<void>;
        abort(reason?: unknown): Promise<void>;
      };
    };
  };

  export = streamSaver;
}
