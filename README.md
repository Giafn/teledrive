# Teledrive

Panduan operasional singkat untuk project saat ini.

## Arsitektur dan batasan

- Browser menjalankan MTProto langsung melalui `@mtcute/web`. File dipecah, di-hash, lalu dikirim browser langsung ke Telegram.
- Cloudflare Worker menangani passkey, session, D1, folder, object manifest, upload metadata, dan webhook linking. Worker tidak menerima atau mem-proxy byte file.
- Vercel/Next.js hanya menyajikan frontend. Vercel tidak pernah menjadi proxy byte file.
- Worker MVP belum memverifikasi permission bot/channel Telegram secara nyata.
- Permanent delete Worker hanya menghapus metadata D1. Media fisik Telegram tidak dihapus; pesan Telegram dapat menjadi orphan.

## Prasyarat

- Node.js 20 atau lebih baru.
- Corepack dan pnpm.
- Akun Cloudflare dengan Workers dan D1.
- Project Vercel.
- Telegram app dengan API ID/API hash, private channel, dan bot.
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

`NEXT_PUBLIC_API_URL` adalah nama yang benar; bukan `API_BASE_URL`. `BOOTSTRAP_TOKEN` dalam root `.env.local` dipakai oleh generated `.dev.vars` untuk first passkey registration; gunakan value lokal/transient, jangan pakai production secret.

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

Edit `apps/worker/wrangler.toml`: ganti `database_id = "REPLACE_WITH_D1_DATABASE_ID"` dengan ID hasil command. Jika memakai nama database lain, ganti juga `database_name`. Set plaintext Worker variables `APP_ORIGIN`, `RP_ID`, dan `RP_NAME` di Cloudflare Dashboard atau CI/deployment system, di luar repository. `apps/worker/wrangler.toml` sengaja tidak memiliki `[vars]`, sehingga tidak ada nilai local atau production yang bersaing. Set Worker secrets secara terpisah; secrets tidak boleh dikirim ke Vercel/browser. Root `.env.local` dan `env:sync` hanya untuk local; production tidak boleh memakai satu file bersama karena Worker secrets tidak boleh mencapai Vercel atau browser.

Apply dua migration yang ada, berurutan:

```sh
npx wrangler d1 migrations apply teledrive --remote
```

Set tiga Worker secrets berikut. Masukkan value melalui prompt Wrangler; jangan commit value:

```sh
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put APP_SESSION_SECRET
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Deploy Worker:

```sh
npx wrangler deploy
```

Attach custom domain `api.example.com` pada Cloudflare Dashboard: **Workers & Pages → worker → Settings → Domains & Routes → Add Custom Domain**.

### 2. Telegram webhook

Konfigurasikan webhook Telegram ke:

```text
https://api.example.com/v1/webhooks/telegram
```

Gunakan `secret_token` yang sama dengan `TELEGRAM_WEBHOOK_SECRET`. Jika memakai Bot API `setWebhook`, berikan bot token hanya melalui secret manager atau environment sementara; jangan commit, jangan masukkan ke Vercel client variables, dan jangan menaruhnya di source. Worker saat ini hanya memvalidasi header secret; Worker tidak memanggil Bot API.

### 3. Vercel frontend

Buat project Vercel dengan **Root Directory** `apps/web`. Gunakan framework Next.js dan build command default/automatic; package script saat ini adalah `next build`. `apps/web/next.config.mjs` menetapkan `output: 'export'`, sehingga hasilnya static export.

Set environment variables Vercel berikut untuk environment deployment:

```dotenv
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_TELEGRAM_API_ID=123456
NEXT_PUBLIC_TELEGRAM_API_HASH=telegram-app-api-hash
NEXT_PUBLIC_TELEGRAM_CHANNEL=@private_channel_or_configured_channel
```

Deploy dari Vercel Dashboard atau CLI setelah variable tersimpan. Jangan memasukkan `BOOTSTRAP_TOKEN`, `APP_SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, bot token, atau secret Worker lain ke variable frontend.

## Catatan keamanan Telegram

`NEXT_PUBLIC_TELEGRAM_API_HASH` memang dibutuhkan implementasi MTProto client-side saat ini dan akan ikut dibundle ke frontend. API hash bukan user auth session, OTP, password 2FA, atau auth key Telegram. Jangan menyamakan API hash dengan secret Worker. Gunakan Telegram app khusus untuk deployment ini. OTP, password 2FA, dan session auth key tetap diproses di browser, bukan dikirim ke Worker.

## Troubleshooting

- **Login gagal karena Origin/SameSite:** `APP_ORIGIN` harus sama persis dengan origin frontend, termasuk scheme, host, dan port. Local harus `http://localhost:3000`; production harus `https://drive.example.com`. API custom domain harus same-site agar cookie `SameSite=Lax` dapat bekerja; request frontend tetap harus memakai credentials.
- **Migration gagal:** jalankan `npx wrangler d1 migrations apply teledrive --local` untuk database lokal atau `--remote` untuk database produksi dari `apps/worker`. Pastikan `database_name` dan `database_id` pada `wrangler.toml` benar.
- **Telegram tidak terhubung:** pastikan `NEXT_PUBLIC_TELEGRAM_API_ID`, `NEXT_PUBLIC_TELEGRAM_API_HASH`, dan `NEXT_PUBLIC_TELEGRAM_CHANNEL` tersedia di `apps/web/.env.local`/Vercel. API ID dan hash berasal dari Telegram app; Worker tidak membutuhkan bot token untuk endpoint metadata.
- **Upload mobile berhenti:** browser mobile dapat menangguhkan JavaScript ketika tab/PWA berada di background. Buka kembali aplikasi untuk resume; ini batas runtime browser, bukan jalur proxy Worker.

## Dokumentasi utama

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Telegram API ID/API hash](https://core.telegram.org/api/obtaining_api_id)
- [Telegram Bot API `setWebhook`](https://core.telegram.org/bots/api#setwebhook)
