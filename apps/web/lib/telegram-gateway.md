# Browser Telegram adapter

Set `NEXT_PUBLIC_TELEGRAM_API_ID` and `NEXT_PUBLIC_TELEGRAM_API_HASH` to credentials supplied by the Telegram app owner. Set `NEXT_PUBLIC_TELEGRAM_CHANNEL` to a public username or marked channel ID, or pass `channel` to `createTelegramGateway`.

`telegramGateway` starts `app/telegram.worker.ts` only in a browser. Worker owns `BaseTelegramClient`, `TelegramWorker`, and IndexedDB storage key `teledrive.telegram.account`. Auth session/auth keys never leave Worker or IndexedDB. Phone, OTP, 2FA password, and pending phone-code hash stay in Worker memory; they are not logged, persisted, returned, or sent to the Teledrive API. OTP and 2FA are sent only by mtcute's Telegram RPC calls from Worker.

Manual auth uses `sendCode`, `signIn`, `checkPassword`, `resendCode`, `checkConnection`, and `logOut`/`logout`. Documented auth parameter objects are accepted, but phone/hash/options are stripped at gateway boundary; Worker-held pending state is used. Auth methods return redacted state only. `sendCode` must precede `signIn`/`resendCode`; pending login state is lost if Worker is terminated.

Upload sends each `File`/`Blob` as a typed mtcute `document` message to configured channel and returns Telegram message ID plus safe metadata. Download resolves a typed channel/message with `getMessages` and `downloadAsBuffer`; document messages are supported, while other media return explicit configuration errors. Returned bytes use structured clone. No server upload/download fallback exists. `@mtcute/web` is pinned to `0.31.0`.
