# Crypto boundary

Exports SHA-256, CSPRNG share-token generation, token hashing, and log redaction using Web Crypto.

Session encryption is intentionally absent. Runtime integration must provide a user-held, non-hardcoded key and define key lifecycle before storing MTProto session data. Never send OTP, 2FA password, auth key, or session material to Worker APIs.
