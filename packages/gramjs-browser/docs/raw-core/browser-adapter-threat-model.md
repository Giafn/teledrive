# Browser Adapter Threat Model

## Status and non-authorization

**B2.2c reducer approved; direct runtime remains blocked.**

**This document authorizes no source, test, script, package, README, public API, browser API, endpoint, or traffic change.**

**No endpoint acceptance, browser feasibility, or live-runtime claim is made.**

**No live traffic, test-DC traffic, connection attempt, or endpoint data is authorized.**

**No reconnect, resend, replay, proxy, multiplexing, framing, obfuscation, TL, crypto, auth, session, credential, persistence, upload, or download implementation is authorized.**

## Scope and assets

Future-sensitive assets: authorization key, session material, salt, message identifiers, opaque encrypted frames, user data, endpoint configuration, and telemetry. B2.2c currently holds none of these as runtime assets; this record describes future risk only.

## Trust boundary

```text
page origin → controller → B2.2c reducer → future adapter → browser TLS/WSS → separately reviewed endpoint policy
```

The reducer supplies bounded opaque queues. Controller and endpoint policy are distinct authorities. Browser TLS is not application cryptography.

## Threats, mitigations, and gaps

| Threat | Required mitigation | Known gap |
|---|---|---|
| Hostile peer bytes | Opaque handling, finite queues, strict terminal state, no parser in adapter | Peer behavior untested until synthetic gate |
| Endpoint substitution | External authority, allowlist, revocation, fail-closed policy; no endpoint selection in data | Authority and values not approved |
| Browser origin, extension, or XSS exposure | Trusted page-origin policy, CSP, dependency and extension review, least exposure of sensitive material | Deployment controls unknown |
| CSP misconfiguration | Explicit `connect-src` review and negative tests; reject unintended origins | No browser boundary exists |
| Memory DoS/backpressure | Bounded admission, bounded copies, pressure result, cancellation; never rely on `bufferedAmount` as automatic backpressure | Limits not selected |
| Close/error untrusted text | Redact reason and browser error detail; expose approved categories only | Redaction evidence pending |
| Suspension/cancel races | Idempotent teardown, late-event suppression, lifecycle interruption tests | Browser timing unknown |
| Proxy or interception | Native TLS assumptions plus separately reviewed deployment and endpoint policy; do not claim proxy safety | No deployment evidence |
| Telemetry leakage | Do not log bytes, credentials, endpoints, close text, or exact sensitive identifiers; review fields and retention | Telemetry design absent |
| Duplicate, replay, reconnect | Explicitly absent from current scope; no implicit retry or resend | Future protocol design required if ever requested |
| Terms, abuse, privacy | Own API identity, privacy review, rate limits, flood/spam controls, incident path, and Terms approval | Owners and operating evidence pending |

## Control status

- **Controls now:** no runtime, no connection path, all-source guard, and bounded B2.2c reducer behavior.
- **Future requirements:** adapter boundary, lifecycle/queue controls, browser policy, endpoint authority, telemetry minimization, and all staged approvals above.
- **Unknowns:** browser acceptance, deployment origin/CSP, proxy/interception conditions, endpoint policy, test-DC behavior, production behavior, and operational limits.

## Roles

Release owner gates artifacts and rollout. Security owner reviews boundary, secrets, and abuse resistance. Legal/Terms owner approves API Terms use. Privacy owner approves data handling and telemetry. Abuse/rate-limit owner sets quotas and monitoring. Incident owner defines response, disablement, and evidence handling. Names are intentionally omitted.

## Sources

- Telegram, “MTProto Mobile Protocol: Transports”: ordered streams, independent framing, required obfuscation, WebSocket binary/subprotocol behavior, and close caveats. https://core.telegram.org/mtproto/mtproto-transports (retrieved 2026-08-12).
- Telegram, “MTProto Mobile Protocol”: authorization/session sensitivity. https://core.telegram.org/mtproto (retrieved 2026-08-12).
- Telegram, “API Terms of Service”; “Obtaining API ID”: privacy, own API ID, abuse/flood/spam constraints. https://core.telegram.org/api/terms and https://core.telegram.org/api/obtaining_api_id (retrieved 2026-08-12).
- MDN, “WebSocket”; “WebSocket() constructor”; “CSP: connect-src”; “CORS”: browser protocol selection, binary behavior, buffering, close/error limits, origin, CSP, and mixed-origin constraints. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket, https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket, https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src, https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS (retrieved 2026-08-12).
