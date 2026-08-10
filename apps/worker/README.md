# Teledrive metadata Worker

Cloudflare Worker API for passkey/Google authentication, D1 metadata, upload manifests, and per-user Telegram Bot API onboarding. Legacy metadata/MTProto routes never receive file bytes; Phase 2 Bot API part routes stream raw bytes through Worker to Telegram. Worker never receives Telegram MTProto auth keys, OTPs, phone numbers, or 2FA passwords.

## Local checks

```sh
cd apps/worker
npm install
npm test
npm run typecheck
npm run build
```

Runtime dependencies are Hono, `@simplewebauthn/server@13.3.2`, and `jose`. Vitest and TypeScript are development-only.

## D1 and deploy

1. Create D1 database and put its ID in `wrangler.toml`:

   ```sh
   npx wrangler d1 create teledrive
   ```

2. Apply migration locally or remotely:

   ```sh
   npx wrangler d1 migrations apply teledrive --local
   npx wrangler d1 migrations apply teledrive --remote
   ```

   Apply migrations in order, including `0002_oracle_audit_fixes.sql`, `0003_multiuser_google_bot.sql`, `0004_bot_transfer.sql`, `0005_bot_part_attempts.sql`, `0006_bot_part_attempt_leases.sql`, and `0007_bot_part_attempt_generations.sql`, before serving traffic.

3. Set non-secret vars in Wrangler environments:
   `APP_ORIGIN` (exact frontend origin), `RP_ID` (WebAuthn host), `RP_NAME`, `GOOGLE_CLIENT_ID`, `GOOGLE_CALLBACK_URL`, `TELEGRAM_BOT_TOKENS`, dan `TELEGRAM_SHARED_CHANNEL`. Register exact HTTPS `GOOGLE_CALLBACK_URL` in Google Cloud.

4. Store secrets. Never put values in source or logs:

   ```sh
   npx wrangler secret put BOOTSTRAP_TOKEN
   npx wrangler secret put APP_SESSION_SECRET
   npx wrangler secret put TELEGRAM_BOT_TOKENS
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   `TELEGRAM_BOT_TOKENS` must be comma-separated `botId:token` pairs (e.g., `123:AAAA,456:BBBB`). All bots must be administrators of the channel specified by `TELEGRAM_SHARED_CHANNEL` (`@username` or numeric id). Worker lazily resolves channel id via `getChat` and caches in D1.

5. Deploy:

   ```sh
   npx wrangler deploy
   ```

The browser first calls `GET /v1/auth/csrf`, sends its returned token as `X-CSRF-Token`, and uses credentials for the session cookie. Mutations require exact `Origin: APP_ORIGIN`; webhook requests use Telegram's configured per-bot secret header instead. Google authorization uses a short-lived host-only `__Host-` state cookie plus D1 transaction. If API uses custom domain separate from frontend, keep it same-site (same registrable site) so `SameSite=Lax` cookie behavior remains predictable; CORS still requires exact `APP_ORIGIN`.

## API boundaries

Authenticated metadata endpoints include `GET /v1/objects/recent` and `GET /v1/trash` (stable cursors, limit 1–100), plus `PATCH /v1/objects/:id` for completed-object rename/move. Trash reports 30-day retention timestamps; listing never purges rows. Folder restore requires an active parent, and object/folder permanent deletion requires prior soft deletion.

Upload start and legacy part commit accept metadata only. `PUT /v1/uploads/:id/parts/:no` does not accept or proxy a blob. Completion validates contiguous part numbers, declared sizes, SHA-256-shaped values, count, and total size. The Worker cannot independently calculate the full object hash because those legacy file bytes never reach it; `objects.sha256` is client-asserted metadata. Phase 2 Bot routes verify each streamed part size and SHA-256 while forwarding its raw body to Telegram.

`GET /v1/telegram/pool` returns shared storage pool status: `{ channel: string; botCount: number; ready: boolean }`. No per-user onboarding, no webhook, no per-user bot configuration.

Phase 2 transfer routes use `POST /v1/bot/uploads` for metadata and `PUT /v1/bot/uploads/:id/parts/:no` for one raw `application/octet-stream` body. Part requests declare `X-Part-Size`, `X-Part-SHA256`, and `X-Idempotency-Key`; Worker durably reserves each part attempt before streaming a generated multipart request to Telegram and never buffers file content. Parts are striped across the bot pool via deterministic hash of idempotency key; each bot handles ~1 msg/s sustained, so N bots ≈ N parts/s. Reserved attempts use a compare-and-swap send claim. Sending claims have bounded leases sized to the part upload (60s floor, plus ~10s per 1 MiB): a live lease returns in-progress, an expired lease becomes ambiguous — also surfaced by attempt polling — and no retry auto-resends. Inspect owner-only `GET /v1/bot/uploads/:id/parts/:no/attempt`; explicitly abandon an ambiguous attempt with `POST /v1/bot/uploads/:id/parts/:no/attempt/abandon` before retrying with a new idempotency key. Telegram may already contain an abandoned part, so retry can create a duplicate. `GET /v1/bot/objects/:id/manifest`, `GET /v1/bot/objects/:id/parts/:no`, and `GET /v1/bot/objects/:id/parts/:no/content` enforce owner-only reads. Telegram identifiers, paths, URLs, and tokens remain server-only. Rate-limited Telegram responses return safe HTTP 429 responses with bounded `Retry-After` values exposed by CORS.

Object permanent deletion is metadata-only: it is allowed only after soft delete and removes D1 object/part rows. Worker does not call Telegram to delete media, so Telegram messages can remain orphaned. Folder permanent deletion also requires soft delete and no child metadata.

Sessions contain only HMAC hashes of opaque random cookies. Passkey challenges are short-lived and single-use. Passkey public keys and counters are stored in D1.

Authentication rate control uses D1 windows keyed by HMAC(`CF-Connecting-IP`, `APP_SESSION_SECRET`), not raw IP storage. OAuth transactions, stale rate rows, and Telegram replay IDs are opportunistically purged by Worker requests; replay retention is 48 hours.
