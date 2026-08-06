# Telegram gateway boundary

`TelegramGateway` is the only browser-facing upload/download boundary. No MTProto dependency is included before library research and an adapter review.

`FakeTelegramGateway` is deterministic in-memory test infrastructure only. It does not log in, contact Telegram, or prove MTProto delivery. Runtime integration must implement `TelegramGateway` with a vetted browser-compatible MTProto client; OTP, 2FA password, auth key, and session must remain in browser memory/storage and never enter Worker requests or logs.
