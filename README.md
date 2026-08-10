# Teledrive

Panduan operasional singkat untuk project saat ini.

## Arsitektur dan batasan

- Browser calls authenticated Worker Bot API routes for metadata and streamed file parts.
- Cloudflare Worker menangani passkey, Google OIDC, opaque session, D1, folder, private/shared authorization, per-user Bot API onboarding, dan Bot API streaming. Worker menerima file bytes only on direct API routes; Vercel never proxies them.
- Vercel/Next.js hanya menyajikan frontend. Vercel tidak pernah menjadi proxy byte file.
- Worker verifies each configured bot token, webhook secret, one-time channel challenge, and bot administrator/post permission before binding.
- Permanent delete Worker hanya menghapus metadata D1. Media fisik Telegram tidak dihapus; pesan Telegram dapat menjadi orphan.

## Prasyarat

- Node.js 20 atau lebih baru.
- Corepack dan pnpm.
- Akun Cloudflare dengan Workers dan D1.
- Project Vercel.
- Google OAuth client, private channel, dan BotFather bot.
- Domain HTTPS untuk deployment produksi. Frontend dan API sebaiknya same-site, misalnya `drive.example.com` dan `api.example.com`.

## Local development

Root workspace memakai `package.json` dan `pnpm-workspace.yaml`. Install seluruh workspace dari root:

```sh
corepack enable
corepack pnpm install
```

### Satu sumber environment lokal

Salin template, lalu edit satu file saja: root `.env.local`.

```sh
cp .env.example .env.local
# edit .env.local
corepack pnpm env:sync
```

`env:sync` memakai Node 20 `process.loadEnvFile`, memvalidasi semua variable, lalu membuat file ignored `apps/web/.env.local` dan `apps/worker/.dev.vars`. File generated memiliki header jangan-edit. Rerun `corepack pnpm env:sync` setiap kali root `.env.local` berubah. Jangan membuat symlink.

`NEXT_PUBLIC_API_URL` adalah nama yang benar; bukan `API_BASE_URL`. `BOOTSTRAP_TOKEN` dalam root `.env.local` tetap tersedia untuk legacy first-passkey bootstrap; ordinary passkey registration tidak membutuhkan token. Local Worker sync juga membutuhkan `TELEGRAM_BOT_TOKENS`, `TELEGRAM_SHARED_CHANNEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, dan `GOOGLE_CALLBACK_URL`; gunakan placeholder/local secret, jangan pakai production value.

### Worker dan web local

Generated `.dev.vars` memasok `APP_ORIGIN=http://localhost:3000` dan `RP_ID=localhost`; jangan edit `wrangler.toml` untuk local environment. Jalankan migration dan Worker:

```sh
cd apps/worker
npx wrangler d1 migrations apply teledrive --local
npx wrangler dev --port 8787
```

Worker harus berjalan di `http://localhost:8787`; frontend harus memakai URL itu. Jalankan Next.js di terminal lain:

```sh
cd apps/web
corepack pnpm dev
```

Next.js berjalan di `http://localhost:3000` secara default.

## Test dan build

Jalankan seluruh test dan typecheck dari root:

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm --filter @teledrive/worker typecheck
corepack pnpm --filter @teledrive/web build
```

`apps/worker` memakai Vitest; script `build` Worker saat ini menjalankan TypeScript check (`tsc --noEmit`).

### Phase 2 Bot API routes

- `POST /v1/bot/uploads`: authenticated JSON metadata start. `size` max 5 GiB, `chunkSize` max 19 MiB, `visibility` is `private` or `shared`.
- `PUT /v1/bot/uploads/:id/parts/:no`: authenticated raw `application/octet-stream`. Send `X-Part-Size`, `X-Part-SHA256`, and `X-Idempotency-Key`; Worker streams generated multipart directly to Telegram.
- `GET /v1/bot/uploads/:id/parts/:no/attempt` and `POST /v1/bot/uploads/:id/parts/:no/attempt/abandon`: owner-only durable attempt status and explicit ambiguous-attempt abandonment. Abandonment never auto-resends; retry requires a new idempotency key and Telegram may contain a duplicate.
- `GET /v1/bot/objects/:id/manifest` and `GET /v1/bot/objects/:id/parts/:no`: owner/shared-authorized sanitized manifest/content. `GET /v1/shared/objects` lists shared files for signed-in users.

Bot/file identifiers, file paths, bot tokens, and Telegram URLs never appear in these responses. Part SHA-256 is verified while streaming; object-level SHA-256 is client-asserted metadata. File bodies bypass Vercel and cache.

## Production deployment

### 1. Worker dan D1

Pilih domain same-site, misalnya:

- Frontend: `https://drive.example.com`
- API: `https://api.example.com`

Buat database dari `apps/worker`:

```sh
cd apps/worker
npx wrangler d1 create teledrive
```

Edit `apps/worker/wrangler.toml`: ganti `database_id = "REPLACE_WITH_D1_DATABASE_ID"` dengan ID hasil command. Jika memakai nama database lain, ganti juga `database_name`. Set plaintext Worker variables `APP_ORIGIN`, `RP_ID`, `RP_NAME`, `GOOGLE_CLIENT_ID`, `GOOGLE_CALLBACK_URL`, `TELEGRAM_BOT_TOKENS`, dan `TELEGRAM_SHARED_CHANNEL` di Cloudflare Dashboard atau CI/deployment system, di luar repository. `GOOGLE_CALLBACK_URL` harus sama persis dengan redirect URI Google dan menunjuk ke `/v1/auth/google/callback`. `apps/worker/wrangler.toml` sengaja tidak memiliki `[vars]`, sehingga tidak ada nilai local atau production yang bersaing. Set Worker secrets secara terpisah; secrets tidak boleh dikirim ke Vercel/browser. Root `.env.local` dan `env:sync` hanya untuk local; production tidak boleh memakai satu file bersama karena Worker secrets tidak boleh mencapai Vercel atau browser.

Apply eight migrations in order:

```sh
npx wrangler d1 migrations apply teledrive --remote
```

Set Worker secrets through Wrangler prompts; never commit values:

```sh
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put APP_SESSION_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKENS
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Google production requires OAuth Client ID, Client Secret, and exact HTTPS callback URL registered in Google Cloud. Worker validates Google ID tokens with RS256 against Google remote JWKS, exact issuer, audience, expiry, nonce, and subject; email is not identity key.

Deploy Worker:

```sh
npx wrangler deploy
```

Attach custom domain `api.example.com` pada Cloudflare Dashboard: **Workers & Pages → worker → Settings → Domains & Routes → Add Custom Domain**.

### 2. Telegram webhook

Shared bot pool: admin configures `TELEGRAM_BOT_TOKENS` (comma-separated `botId:token`) and `TELEGRAM_SHARED_CHANNEL` (`@username` or numeric id). All bots must be administrators of the shared channel. Worker lazily resolves channel id via `getChat` and caches in D1. No per-user onboarding, no webhook, no cloudflared tunnel needed locally.

`TELEGRAM_BOT_TOKENS` must be stored as Worker secret (never in repo). Bot tokens enter Worker only over HTTPS and never enter Vercel variables, logs, or API responses.

### 3. Vercel frontend

Buat project Vercel dengan **Root Directory** `apps/web`. Gunakan framework Next.js dan build command default/automatic; package script saat ini adalah `next build`. `apps/web/next.config.mjs` menetapkan `output: 'export'`, sehingga hasilnya static export.

Set environment variables Vercel berikut untuk environment deployment:

```dotenv
NEXT_PUBLIC_API_URL=https://api.example.com
```

Deploy dari Vercel Dashboard atau CLI setelah variable tersimpan. Jangan memasukkan `BOOTSTRAP_TOKEN`, `APP_SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, bot token, atau secret Worker lain ke variable frontend.

## Troubleshooting

- **Login gagal karena Origin/SameSite:** `APP_ORIGIN` harus sama persis dengan origin frontend, termasuk scheme, host, dan port. Local harus `http://localhost:3000`; production harus `https://drive.example.com`. API custom domain harus same-site agar cookie `SameSite=Lax` dapat bekerja; request frontend tetap harus memakai credentials.
- **Migration gagal:** jalankan `npx wrangler d1 migrations apply teledrive --local` untuk database lokal atau `--remote` untuk database produksi dari `apps/worker`. Pastikan `database_name` dan `database_id` pada `wrangler.toml` benar.
- **Google login gagal:** pastikan `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, dan exact `GOOGLE_CALLBACK_URL` production values are configured on Worker; callback URL must match Google Cloud registration.
- **Telegram bot onboarding gagal:** pastikan `TELEGRAM_BOT_TOKENS` diisi (comma-separated `botId:token`), `TELEGRAM_SHARED_CHANNEL` benar (`@username` atau numeric id), dan semua bot sudah admin channel. Worker resolve channel otomatis via `getChat`; cek log Worker kalau gagal.
- **Upload mobile berhenti:** browser mobile dapat menangguhkan JavaScript ketika tab/PWA berada di background. Buka kembali aplikasi untuk resume; ini batas runtime browser, bukan jalur proxy Worker.

## Dokumentasi utama

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Telegram Bot API `setWebhook`](https://core.telegram.org/bots/api#setwebhook)
