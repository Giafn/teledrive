# Teledrive metadata Worker

Cloudflare Worker API for passkey authentication, D1 metadata, upload manifests, and Telegram linking. Worker never receives file bytes, Telegram MTProto auth keys, OTPs, phone numbers, or 2FA passwords.

## Local checks

```sh
cd apps/worker
npm install
npm test
npm run typecheck
npm run build
```

Runtime dependencies are Hono and `@simplewebauthn/server@13.3.2`. Vitest and TypeScript are development-only.

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

   Apply migrations in order, including `0002_oracle_audit_fixes.sql`, before serving traffic.

3. Set non-secret vars in `wrangler.toml` or Wrangler environments:
   `APP_ORIGIN` (exact frontend origin), `RP_ID` (WebAuthn host), and `RP_NAME`.

4. Store secrets. Never put values in source or logs:

   ```sh
   npx wrangler secret put BOOTSTRAP_TOKEN
   npx wrangler secret put APP_SESSION_SECRET
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

5. Deploy:

   ```sh
   npx wrangler deploy
   ```

The browser first calls `GET /v1/auth/csrf`, sends its returned token as `X-CSRF-Token`, and uses credentials for the session cookie. Mutations require exact `Origin: APP_ORIGIN`; webhook requests use Telegram's configured secret header instead. If API uses custom domain separate from frontend, keep it same-site (same registrable site) so `SameSite=Lax` cookie behavior remains predictable; CORS still requires exact `APP_ORIGIN`.

## API boundaries

Authenticated metadata endpoints include `GET /v1/objects/recent` and `GET /v1/trash` (stable cursors, limit 1–100), plus `PATCH /v1/objects/:id` for completed-object rename/move. Trash reports 30-day retention timestamps; listing never purges rows. Folder restore requires an active parent, and object/folder permanent deletion requires prior soft deletion.

Upload start and part commit accept metadata only. `PUT /v1/uploads/:id/parts/:no` does not accept or proxy a blob. Completion validates contiguous part numbers, declared sizes, SHA-256-shaped values, count, and total size. The Worker cannot independently calculate the full object hash because file bytes intentionally never reach it; client-provided full hash is compared with the declared upload hash.

Telegram linking creates a short-lived one-time code. The webhook consumes only `/link CODE` updates and stores Telegram user/chat identifiers. It does **not** call Bot API and does not claim channel or bot permissions are verified. Real bot permission verification remains unimplemented.

Object permanent deletion is metadata-only: it is allowed only after soft delete and removes D1 object/part rows. Worker does not call Telegram to delete media, so Telegram messages can remain orphaned. Folder permanent deletion also requires soft delete and no child metadata.

Sessions contain only HMAC hashes of opaque random cookies. Passkey challenges are short-lived and single-use. Passkey public keys and counters are stored in D1.

Authentication rate control is conservative per Cloudflare Worker isolate and `CF-Connecting-IP`; it is not a distributed quota. Durable abuse protection requires a shared rate-limit service or D1 design after measured need.
