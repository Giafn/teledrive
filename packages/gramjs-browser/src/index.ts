/** Planner/mock evidence only. Direct MTProto runtime remains unavailable. */
export const GRAMJS_BROWSER_RUNTIME_STATUS = 'planner-only-runtime-unavailable' as const;

export type GramJsBrowserRuntimeStatus = typeof GRAMJS_BROWSER_RUNTIME_STATUS;

export type GramJsBrowserRuntimeSeam = {
  readonly status: GramJsBrowserRuntimeStatus;
};

export * from './contracts.ts';
export * from './file-reference.ts';
export * from './planner.ts';
export * from './retry.ts';
