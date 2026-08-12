# Browser Adapter Test Plan

## Status and non-authorization

**B2.2c reducer approved; direct runtime remains blocked.**

**This document authorizes no source, test, script, package, README, public API, browser API, endpoint, or traffic change.**

**No endpoint acceptance, browser feasibility, or live-runtime claim is made.**

**No live traffic, test-DC traffic, connection attempt, or endpoint data is authorized.**

**No reconnect, resend, replay, proxy, multiplexing, framing, obfuscation, TL, crypto, auth, session, credential, persistence, upload, or download implementation is authorized.**

## Current test scope

Zero-network synthetic fake-adapter tests only. Tests must not use the WebSocket global, any endpoint, traffic, transport framing, or cryptography. Fake events contain project-authored opaque bytes only.

## Matrix

| Area | Required assertion |
|---|---|
| Lifecycle and terminal late events | Open, close, cancel, and terminal transitions are deterministic; late events are ignored and cannot revive state. |
| Binary-only opaque copies | Only synthetic binary values are admitted; ownership copies prevent mutation or aliasing; bytes are never parsed or logged. |
| Split/coalesced synthetic events | Artificial split or coalesced events are rejected as transport assumptions; adapter consumes complete browser-message units, not MTProto frames. |
| Outbound FIFO and exact acknowledgement | FIFO order preserved; acknowledgement uses exact opaque token; token is not logged. |
| Capacity and pressure | Finite limits reject or report pressure deterministically; no unbounded copy or queue growth. |
| Cancellation and cleanup | Cancellation is idempotent, releases references, settles pending work, and suppresses late callbacks. |
| Close/error redaction | Peer-controlled reason and browser error detail never escape approved redacted categories or telemetry. |
| No reconnect/replay | Disconnect produces terminal failure; no implicit reconnect, resend, duplicate, or replay. |
| Strict fixture marker rejection | Any fixture claiming live, endpoint, browser API, credential, API, DC, Telegram, or captured-packet behavior is rejected. |
| Graph/scope checks | Repository checks confirm docs-only scope and no runtime import, endpoint, or network path is introduced. |

## Fixture requirements

Every fixture must be project-authored, synthetic, and marked `notLive`. Fixture review rejects endpoint, network, browser API, credential, API, DC, Telegram, or captured-packet claims. No fixture may contain endpoint data, traffic, secrets, or frame payloads. Test names and assertions must not imply browser feasibility or live acceptance.

## Later evidence criteria (not authorized now)

Each item requires separate approval and must not be inferred from fake tests:

- **Browser API boundary:** isolated browser evidence for binary mode, subprotocol behavior, lifecycle, close/error limits, origin, CSP, and mixed-content outcomes, with no endpoint acceptance claim.
- **Endpoint policy:** independently reviewed authority, allowlist, revocation, and fail-closed behavior; endpoint values remain outside this plan.
- **Closed-world traffic:** separately authorized evidence with controlled traffic, redacted captures, and no production implication.
- **Test-DC:** explicit test-DC authorization, Terms/privacy/security review, rate limits, and incident controls.
- **Production:** release, security, legal/Terms, privacy, abuse/rate-limit, and incident approvals with rollback evidence.

## Sources

- Telegram, “MTProto Mobile Protocol: Transports”: ordered byte streams, independent framing, obfuscation, WebSocket binary/subprotocol behavior, and close caveats. https://core.telegram.org/mtproto/mtproto-transports (retrieved 2026-08-12).
- Telegram, “MTProto Mobile Protocol”; “API Terms of Service”; “Obtaining API ID”: sensitive authorization/session material, privacy, own API ID, and abuse/flood/spam constraints. https://core.telegram.org/mtproto, https://core.telegram.org/api/terms, https://core.telegram.org/api/obtaining_api_id (retrieved 2026-08-12).
- MDN, “WebSocket”; “WebSocket() constructor”; “CSP: connect-src”; “CORS”: binary type, buffering, send/close/error behavior, protocol selection, origin, CSP, and mixed-content constraints. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket, https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket, https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src, https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS (retrieved 2026-08-12).
