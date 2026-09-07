# Deployment Guide (Cloudflare Worker + Vercel)

For the next agent doing a deploy on this repo. Read this before running any
`wrangler` / `vercel` command — there are two non-obvious footguns below that
already bit once.

## Architecture

- `apps/worker` — Cloudflare Worker (Hono), binds D1 (`DB`). Deployed with `wrangler`.
- `apps/web` — Next.js 14, `output: 'export'` (static site). Deployed to Vercel.
- Monorepo, pnpm workspaces. `apps/web` calls the worker via `NEXT_PUBLIC_API_URL`.
- Telegram MTProto client runs **in the browser** (mtcute), not in the worker.
  That's why `NEXT_PUBLIC_TELEGRAM_API_ID/HASH/CHANNEL` exist as public web env
  vars — the worker does not use them.

## Cloudflare Worker deploy

```bash
cd apps/worker
npx wrangler deploy
```

Prereqs / gotchas:

- `wrangler.toml` `d1_databases.database_id` must be the **real** D1 uuid, not
  a placeholder. Get it with `npx wrangler d1 list`. If deploy or
  `wrangler d1 migrations list <name> --remote` throws `Invalid uuid`, this is why.
- `npx wrangler d1 list` can misreport `num_tables: 0` even when the DB is
  fully populated — it's a stale metadata column, not real state. Verify with:
  ```bash
  npx wrangler d1 execute teledrive --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
  ```
- Migrations live in `/migrations` (repo root), applied via
  `npx wrangler d1 migrations apply teledrive --remote` (run from `apps/worker`,
  `migrations_dir` in `wrangler.toml` points at `../../migrations`).
- Secrets are managed independently of code deploy (`wrangler deploy` does NOT
  touch secrets). List with `npx wrangler secret list`. Set with:
  ```bash
  printf '%s' 'value' | npx wrangler secret put SECRET_NAME
  ```
  Current secrets: `APP_ORIGIN`, `APP_SESSION_SECRET`, `BOOTSTRAP_TOKEN`,
  `GOOGLE_CALLBACK_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REGISTRATION_SECRET`, `RP_ID`, `RP_NAME`, `TELEGRAM_BOT_TOKENS`,
  `TELEGRAM_LOGIN_CALLBACK_URL`, `TELEGRAM_LOGIN_CLIENT_ID`,
  `TELEGRAM_LOGIN_CLIENT_SECRET`, `TELEGRAM_REGISTRATION_SECRET`,
  `TELEGRAM_SHARED_CHANNEL`, `TELEGRAM_WEBHOOK_SECRET`,
  `NEXT_PUBLIC_TELEGRAM_API_ID`, `NEXT_PUBLIC_TELEGRAM_API_HASH`.
- **`APP_ORIGIN` and `RP_ID` on live are production values (real domain),
  different from `.env.local` (which has `localhost` dev values). Never
  overwrite these from `.env.local` blindly** — confirm with the user first.
- `.env.local` (repo root) is a **dev** file; do not assume its values belong
  in production secrets without checking each one against what's live.

## Vercel deploy

The Vercel project is named **`web`** (org `giafns-projects`), with Project
Setting **Root Directory = `apps/web`**. This means Vercel always expects to
receive the **whole monorepo** and cd into `apps/web` itself.

**Footgun: do not run `vercel --prod` from inside `apps/web`.** It uploads
only that subfolder, then Vercel tries to cd into `apps/web/apps/web`, which
doesn't exist, and the deploy fails with:
`The specified Root Directory "apps/web" does not exist.`

**Bigger footgun: if you run `vercel` from the repo root without a `.vercel/`
link there, the CLI does NOT reuse the `apps/web/.vercel` link — it silently
offers to create a brand-new project** (it will even auto-connect the GitHub
repo). This happened once and created a stray `teledrive` project that had to
be deleted with `npx vercel project rm teledrive`.

Correct procedure, every time:

```bash
mkdir -p .vercel   # repo root
cat > .vercel/project.json <<'EOF'
{"projectId":"prj_qdWaFYljoHWTVZefkZU0PTtJPxJd","orgId":"team_FgWVbjyCObYhG6sqoiNHg09w","projectName":"web"}
EOF
npx vercel --prod --cwd "$(pwd)"
```

(`.vercel/` is gitignored — this file needs recreating each fresh checkout /
each time you're not sure it's linked. Check `apps/web/.vercel/project.json`
for the canonical `projectId`/`orgId` if this guide goes stale.)

Before deploying, sanity check you're targeting the right project:
```bash
npx vercel project ls   # confirm "web" exists and is the one being deployed to
```

### Env vars (`NEXT_PUBLIC_*`)

`next build` with `output: 'export'` **bakes `NEXT_PUBLIC_*` vars into the
static bundle at build time**. Adding/changing them via `vercel env add` has
**no effect on already-built output** — you must trigger a fresh build:

```bash
npx vercel env add NEXT_PUBLIC_FOO production
npx vercel --prod --force --cwd "$(pwd)"   # --force skips build cache reuse
```

Current production env vars: `NEXT_PUBLIC_API_URL`,
`NEXT_PUBLIC_TELEGRAM_API_ID`, `NEXT_PUBLIC_TELEGRAM_API_HASH`,
`NEXT_PUBLIC_TELEGRAM_CHANNEL`.

Note: these `NEXT_PUBLIC_TELEGRAM_*` values are visible to anyone visiting the
site (that's what `NEXT_PUBLIC_` means) — this is expected and fine, they are
app identifiers for Telegram's MTProto API, not user credentials. Don't
confuse them with actual secrets (bot tokens, session strings), which must
never be `NEXT_PUBLIC_*`.

## Post-deploy checklist

1. `npx wrangler deployments list` (from `apps/worker`) — confirm the new
   version is live.
2. Hit the worker health/API route directly to confirm it responds.
3. `npx vercel project ls` — confirm "web" has a fresh "Latest Production URL"
   timestamp, and it points at `drive.giafn.my.id`.
4. Open the live site and exercise the actual feature you changed — static
   export means typecheck/build passing doesn't guarantee the deployed page
   works (env vars, CORS to the worker, etc. are runtime concerns).
