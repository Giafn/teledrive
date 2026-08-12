# Browser Adapter Policy

## Status and non-authorization

**B2.2c reducer approved; direct runtime remains blocked.**

**This document authorizes no source, test, script, package, README, public API, browser API, endpoint, or traffic change.**

**No endpoint acceptance, browser feasibility, or live-runtime claim is made.**

**No live traffic, test-DC traffic, connection attempt, or endpoint data is authorized.**

**No reconnect, resend, replay, proxy, multiplexing, framing, obfuscation, TL, crypto, auth, session, credential, persistence, upload, or download implementation is authorized.**

This is a durable policy gate for a possible future adapter. It is not an implementation specification or acceptance record.

## Decision record

- A future adapter is an untrusted I/O boundary. It must not become protocol authority.
- B2.2c reducer owns opaque, bounded inbound and outbound queues. A later controller owns protocol semantics, if separately approved.
- Browser TLS is native browser behavior; application code must not implement or replace it.
- Application data must not select endpoints. Endpoint authority, allowlisting, and revocation belong to separately reviewed policy.
- Adapter input and output are opaque bytes at this boundary. MTProto frame parsing is outside adapter responsibility.

## Requirements before source work

1. **Endpoint authority.** Define an externally controlled allowlist, ownership, revocation path, and fail-closed behavior without placing endpoint values in application data. No values are recorded here.
2. **Browser policy.** Assign ownership for origin, CSP `connect-src`, mixed-content restrictions, and any extension or embedding risk. Origin and policy failure must fail closed.
3. **Binary evidence.** Obtain evidence for binary transport and the required `binary` subprotocol through a separately approved browser boundary. Do not infer acceptance from documentation.
4. **Message boundary.** Treat each complete browser message as the adapter boundary. Do not assume browser message boundaries equal MTProto transport frames; framing is independent.
5. **Admission and pressure.** Set finite queue limits, explicit admission results, and cancellation behavior. `bufferedAmount` is advisory and does not provide automatic backpressure.
6. **Close and error handling.** Redact peer-controlled close reasons and browser error detail before telemetry or caller exposure. Preserve only approved diagnostic categories.
7. **Teardown.** Cancellation must terminate pending work, detach late events, release references, and be idempotent.
8. **Lifecycle interruption.** Define behavior for page suspension, visibility/process termination, navigation, and browser shutdown. Interruption must not silently imply delivery.
9. **No implicit retry.** Reconnect, resend, and replay require explicit future approval and protocol-level design; none may be implicit.

## Staged approval gates

Every stage requires separate approval and evidence. Passing one stage does not authorize the next:

`policy docs → fake adapter (synthetic) → browser API boundary → endpoint policy → closed-world traffic → test-DC → production`

- **Policy docs:** this policy, threat model, and test plan are complete and reviewed.
- **Fake adapter (synthetic):** zero-network lifecycle and queue behavior pass with project-authored synthetic bytes.
- **Browser API boundary:** browser behavior is tested without endpoint selection or traffic claims.
- **Endpoint policy:** authority, allowlist, revocation, origin, CSP, and mixed-content controls are approved; values remain outside this record.
- **Closed-world traffic:** only separately approved closed-world evidence may establish transport behavior.
- **Test-DC:** separate authorization, legal/Terms review, rate limits, and observation controls are required.
- **Production:** separate release, security, privacy, abuse, and incident approvals are required.

## Official sources and facts

- Telegram, “MTProto Mobile Protocol: Transports”: ordered byte-stream semantics; framing is independent of browser message boundaries; obfuscation is required for applicable transports; WebSocket uses binary messaging and documents a `binary` subprotocol; close code/reason behavior has caveats. Documented endpoint behavior and browser acceptance remain unproven here. https://core.telegram.org/mtproto/mtproto-transports (retrieved 2026-08-12).
- Telegram, “MTProto Mobile Protocol”: authorization and session material are sensitive protocol material. https://core.telegram.org/mtproto (retrieved 2026-08-12).
- Telegram, “API Terms of Service”: privacy, abuse, flooding, and spam constraints apply to API use. https://core.telegram.org/api/terms (retrieved 2026-08-12).
- Telegram, “Obtaining API ID”: applications should use their own API ID and must follow API restrictions. https://core.telegram.org/api/obtaining_api_id (retrieved 2026-08-12).
- MDN, “WebSocket”: `binaryType`, `bufferedAmount`, send/close semantics, limited error detail, and lifecycle behavior are browser-defined. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket (retrieved 2026-08-12).
- MDN, “WebSocket() constructor”: protocol selection is constrained to the constructor’s protocol argument; arbitrary request headers are not an application control. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket (retrieved 2026-08-12).
- MDN, “CSP: connect-src”: CSP controls permitted connection targets. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src (retrieved 2026-08-12).
- MDN, “CORS”: browser origin policy constrains cross-origin requests and is not an endpoint authorization mechanism. https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS (retrieved 2026-08-12).

## Unknowns

Browser acceptance of documented transport behavior, deployment-specific origin/CSP policy, endpoint authorization, suspension timing, proxy behavior, and test-DC/production evidence are unknown. No claim is made until its gate has independent evidence.
