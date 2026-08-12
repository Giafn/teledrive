import {
  MAX_FRAME_BYTES,
  MAX_TRACE_ENTRIES,
  TransportStateError,
  TransportStateReducer,
} from '../../src/raw-core/transport-state.ts';

const terminal = new Set(['done', 'broken', 'stopped']);
const freeze = value => Object.freeze(value);

export class OpaqueLaneError extends Error {
  constructor(code) { super(code); this.name = 'OpaqueLaneError'; this.code = code; }
}

export class OpaqueLaneSim {
  #clock; #reducer; #state = 'dormant'; #pressure = false; #last;
  #ackToken; #ackLength; #trace = []; #errorCode;

  constructor(clock) {
    if (!clock || typeof clock.nowMs !== 'function') throw new OpaqueLaneError('clock-invalid');
    this.#clock = clock;
    this.#reducer = new TransportStateReducer(clock);
  }

  #fail(code, event, at = this.#last ?? 0) {
    this.#ackToken = undefined; this.#ackLength = undefined; this.#errorCode = code;
    const from = this.#state;
    if (this.#state !== 'broken') {
      try { this.#reducer.error(); } catch (error) { if (!(error instanceof TransportStateError)) {} }
      this.#state = 'broken';
      this.#row(from, event, at);
    }
    throw new OpaqueLaneError(code);
  }

  #at(event) {
    if (terminal.has(this.#state)) throw new OpaqueLaneError('closed');
    let now;
    try { now = this.#clock.nowMs(); } catch { return this.#fail('clock-invalid', event); }
    if (!Number.isSafeInteger(now) || now < 0 || (this.#last !== undefined && now < this.#last)) {
      return this.#fail('clock-invalid', event);
    }
    this.#last = now;
    return now;
  }

  #row(from, event, atMs) {
    const s = this.#reducer.snapshot();
    const row = { from, event, to: this.#state, atMs, inboundCount: s.inboundCount,
      outboundCount: s.outboundCount, inboundBytes: s.inboundBytes, outboundBytes: s.outboundBytes };
    if (this.#errorCode) row.errorCode = this.#errorCode;
    this.#trace.push(freeze(row));
    if (this.#trace.length > MAX_TRACE_ENTRIES) this.#trace.shift();
  }

  #active(event) {
    const at = this.#at(event);
    if (this.#state !== 'active') throw new OpaqueLaneError('invalid-state');
    return at;
  }

  prepare() {
    const at = this.#at('prepare');
    if (this.#state !== 'dormant') throw new OpaqueLaneError('invalid-state');
    this.#state = 'prepared'; this.#row('dormant', 'prepare', at);
  }

  activate() {
    const at = this.#at('activate');
    if (this.#state !== 'prepared') throw new OpaqueLaneError('invalid-state');
    try { this.#reducer.start(); this.#reducer.markOpen(); }
    catch { return this.#fail('transition', 'activate', at); }
    this.#state = 'active'; this.#row('prepared', 'activate', at);
  }

  offer(value) {
    const at = this.#active('offer');
    if (this.#pressure) return freeze({ result: 'pressure' });
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_FRAME_BYTES) {
      return this.#fail('invalid-input', 'offer', at);
    }
    const owned = new Uint8Array(value);
    try {
      this.#reducer.enqueueOutbound(owned);
      if (this.#ackToken === undefined) {
        const item = this.#reducer.takeOutbound();
        if (!item) return this.#fail('transition', 'offer', at);
        this.#ackToken = item.token; this.#ackLength = item.frame.byteLength; item.frame.fill(0);
      }
      this.#row('active', 'offer', at);
      return freeze({ result: 'accepted' });
    } catch (error) {
      if (error instanceof TransportStateError) return this.#fail(error.code, 'offer', at);
      return this.#fail('reducer', 'offer', at);
    } finally { owned.fill(0); }
  }

  feed(value) {
    const at = this.#active('feed');
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_FRAME_BYTES) {
      return this.#fail('invalid-input', 'feed', at);
    }
    const owned = new Uint8Array(value);
    try { this.#reducer.receiveInbound(owned); this.#row('active', 'feed', at); }
    catch (error) {
      if (error instanceof TransportStateError) return this.#fail(error.code, 'feed', at);
      return this.#fail('reducer', 'feed', at);
    } finally { owned.fill(0); }
  }

  take() {
    const at = this.#active('take');
    try { const value = this.#reducer.takeInbound(); this.#row('active', 'take', at); return value; }
    catch (error) { return this.#fail(error instanceof TransportStateError ? error.code : 'reducer', 'take', at); }
  }

  pressureOn() { const at = this.#active('pressureOn'); this.#pressure = true; this.#row('active', 'pressureOn', at); }
  pressureOff() {
    const at = this.#active('pressureOff'); this.#pressure = false;
    try {
      if (this.#ackToken === undefined) { const item = this.#reducer.takeOutbound(); if (item) { this.#ackToken = item.token; this.#ackLength = item.frame.byteLength; item.frame.fill(0); } }
      this.#row('active', 'pressureOff', at);
    } catch (error) { return this.#fail(error instanceof TransportStateError ? error.code : 'reducer', 'pressureOff', at); }
  }

  accept() {
    const at = this.#active('accept');
    if (this.#ackToken === undefined || this.#ackLength === undefined) return this.#fail('invalid-input', 'accept', at);
    try { this.#reducer.commitOutbound(this.#ackToken, this.#ackLength); }
    catch (error) { return this.#fail(error instanceof TransportStateError ? error.code : 'reducer', 'accept', at); }
    this.#ackToken = undefined; this.#ackLength = undefined; this.#row('active', 'accept', at);
    return freeze({ result: 'accepted' });
  }

  finish() {
    const at = this.#active('finish');
    try { this.#reducer.beginClose(); this.#state = 'draining'; this.#row('active', 'finish', at); this.#reducer.markClosed(); }
    catch { return this.#fail('transition', 'finish', at); }
    this.#state = 'done'; this.#ackToken = undefined; this.#ackLength = undefined; this.#row('draining', 'done', at);
  }

  break() { const at = this.#at('break'); return this.#fail('error', 'break', at); }
  stop() {
    const at = this.#at('stop');
    try { this.#reducer.cancel(); } catch { return this.#fail('transition', 'stop', at); }
    this.#ackToken = undefined; this.#ackLength = undefined; this.#state = 'stopped'; this.#row(this.#state, 'stop', at);
  }
  tick() { const at = this.#at('tick'); this.#row(this.#state, 'tick', at); }
  snapshot() {
    const s = this.#reducer.snapshot();
    const out = { state: this.#state, inboundCount: s.inboundCount, outboundCount: s.outboundCount,
      inboundBytes: s.inboundBytes, outboundBytes: s.outboundBytes, inFlight: s.inFlight,
      pressure: this.#pressure, pending: this.#ackToken !== undefined };
    if (this.#errorCode) out.errorCode = this.#errorCode;
    return freeze(out);
  }
  trace() { return freeze(this.#trace.slice()); }
}

export { MAX_FRAME_BYTES, MAX_TRACE_ENTRIES };
