import { RawCoreError } from './errors.ts';

export const AuthState = {
  idle: 'idle',
  pqRequested: 'pq-requested',
  pqReceived: 'pq-received',
  dhRequested: 'dh-requested',
  dhReceived: 'dh-received',
  clientDhRequested: 'client-dh-requested',
  established: 'established',
  cancelled: 'cancelled',
  failed: 'failed',
} as const;
export type AuthState = typeof AuthState[keyof typeof AuthState];

export interface Clock { readonly nowMs: () => number; }
export interface RandomBytes { readonly take: (length: number) => Uint8Array; }
export interface CryptoTranscript { readonly expect: (label: string, input: Uint8Array) => Uint8Array; }
export interface AuthSimulatorOptions { readonly clock: Clock; readonly random: RandomBytes; readonly transcript: CryptoTranscript; }
export interface TraceEntry { readonly from: AuthState; readonly event: string; readonly to: AuthState; readonly atMs: number; }

const WIDTH = 16;
const FP = /^synthetic-fp-[a-z0-9-]+$/u;
const copy = (x: Uint8Array) => new Uint8Array(x);
const bytes = (x: unknown, nonempty = false): x is Uint8Array =>
  x instanceof Uint8Array && (!nonempty || x.byteLength > 0);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export class AuthSimulator {
  #state: AuthState = AuthState.idle;
  #trace: TraceEntry[] = [];
  #lastMs?: number;
  #nonce?: Uint8Array;
  #serverNonce?: Uint8Array;
  #fingerprints = new Set<string>();
  readonly #clock: Clock;
  readonly #random: RandomBytes;
  readonly #transcript: CryptoTranscript;

  constructor(options: AuthSimulatorOptions) {
    if (!options || !options.clock || !options.random || !options.transcript ||
      typeof options.clock.nowMs !== 'function' || typeof options.random.take !== 'function' ||
      typeof options.transcript.expect !== 'function') throw new RawCoreError('invalid-input');
    this.#clock = options.clock; this.#random = options.random; this.#transcript = options.transcript;
  }

  get state(): AuthState { return this.#state; }
  snapshot() { return Object.freeze({ state: this.#state }); }
  trace(): readonly TraceEntry[] { return Object.freeze(this.#trace.map((x) => Object.freeze({ ...x }))); }

  #time() {
    const now = this.#clock.nowMs();
    if (!Number.isSafeInteger(now) || now < 0 || (this.#lastMs !== undefined && now < this.#lastMs))
      throw new RawCoreError('clock-invalid');
    this.#lastMs = now; return now;
  }
  #clear() { this.#nonce?.fill(0); this.#serverNonce?.fill(0); this.#nonce = undefined; this.#serverNonce = undefined; this.#fingerprints.clear(); }
  #closed(): never { throw new RawCoreError('transport-closed'); }
  #fail(code: 'invalid-input' | 'auth-rejected' | 'clock-invalid' | 'random-unavailable') : never {
    const from = this.#state;
    let atMs = this.#lastMs ?? 0;
    try { atMs = this.#time(); } catch { /* preserve terminal failure when clock itself is bad */ }
    this.#state = AuthState.failed;
    if (from !== AuthState.failed) this.#trace.push(Object.freeze({ from, event: this.#event, to: AuthState.failed, atMs }));
    this.#clear();
    throw new RawCoreError(code);
  }
  #event = '';
  #run(event: string, expected: AuthState, action: (atMs: number) => AuthState) {
    if (this.#state === AuthState.established || this.#state === AuthState.cancelled || this.#state === AuthState.failed) this.#closed();
    this.#event = event;
    let atMs: number;
    try { atMs = this.#time(); } catch (e) { this.#fail('clock-invalid'); }
    if (this.#state !== expected) this.#fail('invalid-input');
    try {
      const to = action(atMs as number);
      this.#trace.push(Object.freeze({ from: expected, event, to, atMs: atMs as number }));
      this.#state = to;
      if (to === AuthState.established) this.#clear();
    } catch (e) {
      if (this.#state === AuthState.failed && e instanceof RawCoreError) throw e;
      if (e instanceof RawCoreError) this.#fail(e.code === 'clock-invalid' ? 'clock-invalid' : e.code === 'random-unavailable' ? 'random-unavailable' : 'auth-rejected');
      this.#fail('auth-rejected');
    }
  }
  #expect(label: string, input: Uint8Array) {
    const result = this.#transcript.expect(label, copy(input));
    if (!bytes(result) || !same(result, input)) throw new RawCoreError('auth-rejected');
  }
  #identity(nonce: unknown, serverNonce: unknown) {
    if (!bytes(nonce) || nonce.length !== WIDTH || !bytes(serverNonce) || serverNonce.length !== WIDTH) this.#fail('invalid-input');
    if (!this.#nonce || !same(nonce, this.#nonce) || !this.#serverNonce || !same(serverNonce, this.#serverNonce)) this.#fail('auth-rejected');
  }

  start() { this.#run('start', AuthState.idle, () => {
    let nonce: Uint8Array;
    try { nonce = this.#random.take(WIDTH); } catch { this.#fail('random-unavailable'); }
    if (!bytes(nonce!) || nonce!.length !== WIDTH) this.#fail('random-unavailable');
    this.#nonce = copy(nonce!); this.#expect('start', this.#nonce); return AuthState.pqRequested;
  }); }
  receiveResPq(input: { nonce: Uint8Array; serverNonce: Uint8Array; fingerprints: string[] }) { this.#run('receiveResPq', AuthState.pqRequested, () => {
    if (!input || !Array.isArray(input.fingerprints) || !input.fingerprints.length || input.fingerprints.some((x) => typeof x !== 'string' || !FP.test(x))) this.#fail('invalid-input');
    if (!bytes(input.nonce) || input.nonce.length !== WIDTH || !bytes(input.serverNonce) || input.serverNonce.length !== WIDTH) this.#fail('invalid-input');
    if (!this.#nonce || !same(input.nonce, this.#nonce)) this.#fail('auth-rejected');
    this.#serverNonce = copy(input.serverNonce); this.#fingerprints = new Set(input.fingerprints); this.#expect('receiveResPq', input.serverNonce); return AuthState.pqReceived;
  }); }
  submitDhParams(input: { nonce: Uint8Array; serverNonce: Uint8Array; fingerprint: string; encryptedData: Uint8Array }) { this.#run('submitDhParams', AuthState.pqReceived, () => {
    if (!input || typeof input.fingerprint !== 'string' || !FP.test(input.fingerprint) || !bytes(input.encryptedData, true)) this.#fail('invalid-input');
    this.#identity(input.nonce, input.serverNonce); if (!this.#fingerprints.has(input.fingerprint)) this.#fail('auth-rejected'); this.#expect('submitDhParams', input.encryptedData); return AuthState.dhRequested;
  }); }
  receiveDhParamsOk(input: { nonce: Uint8Array; serverNonce: Uint8Array; encryptedAnswer: Uint8Array }) { this.#run('receiveDhParamsOk', AuthState.dhRequested, () => {
    if (!input || !bytes(input.encryptedAnswer, true)) this.#fail('invalid-input'); this.#identity(input.nonce, input.serverNonce); this.#expect('receiveDhParamsOk', input.encryptedAnswer); return AuthState.dhReceived;
  }); }
  submitClientDh(input: { nonce: Uint8Array; serverNonce: Uint8Array; encryptedData: Uint8Array }) { this.#run('submitClientDh', AuthState.dhReceived, () => {
    if (!input || !bytes(input.encryptedData, true)) this.#fail('invalid-input'); this.#identity(input.nonce, input.serverNonce); this.#expect('submitClientDh', input.encryptedData); return AuthState.clientDhRequested;
  }); }
  receiveDhGen(input: { kind: 'ok' | 'retry' | 'fail'; nonce: Uint8Array; serverNonce: Uint8Array; hash: Uint8Array }) { this.#run('receiveDhGen', AuthState.clientDhRequested, () => {
    if (!input || !['ok', 'retry', 'fail'].includes(input.kind) || !bytes(input.hash, true)) this.#fail('invalid-input'); this.#identity(input.nonce, input.serverNonce); this.#expect('receiveDhGen', input.hash); if (input.kind !== 'ok') this.#fail('auth-rejected'); return AuthState.established;
  }); }
  cancel() { this.#run('cancel', this.#state, () => { this.#clear(); return AuthState.cancelled; }); }
}
