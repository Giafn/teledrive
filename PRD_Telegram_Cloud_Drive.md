# Product Requirements Document

## Telegram Cloud Drive

Penyimpanan file berbasis Telegram, dibangun dari nol untuk Cloudflare Workers Free dan frontend Vercel

| **Atribut**          | **Nilai**                                                                    |
| -------------------- | ---------------------------------------------------------------------------- |
| Versi dokumen        | Draft 0.1 — untuk review                                                     |
| Tanggal              | 5 Agustus 2026                                                               |
| Status               | Proposal arsitektur dan kebutuhan produk                                     |
| Target deployment    | Frontend: Vercel Hobby • API/metadata: Cloudflare Workers Free + D1          |
| Transport file utama | Telegram MTProto langsung dari browser                                       |
| Penyimpanan blob     | Private Telegram channel; satu file logis terdiri dari beberapa dokumen part |

| **Keputusan teknis utama.** File besar tidak melewati Vercel Functions maupun Cloudflare Worker. Browser mengunggah part langsung ke Telegram melalui MTProto. Worker hanya menerima metadata kecil, menjaga manifest D1, otorisasi aplikasi, webhook bot, dan endpoint berbagi. |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

| **Batas platform.** Local Bot API tidak dapat dijalankan di Cloudflare Worker karena membutuhkan binary, filesystem, dan proses persisten. Ia hanya dapat menjadi mode deployment tambahan di server terpisah. MVP Worker-only menggunakan MTProto di browser dan Bot API HTTPS untuk webhook serta public download per part. |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

# 1. Ringkasan Eksekutif

Produk ini adalah aplikasi web personal-cloud dengan pengalaman menyerupai Google Drive: pengguna dapat membuat folder, mengunggah file besar, melihat progres, melanjutkan upload, mencari, mengunduh, menghapus, dan membagikan file. Isi file disimpan dalam private Telegram channel. Cloudflare D1 menyimpan metadata dan manifest, sedangkan frontend di-host di Vercel.

Agar tetap pada paket gratis dan mampu menangani file besar, data file tidak diproksikan melalui Vercel atau Worker. Browser menjalankan klien MTProto, membagi file logis menjadi dokumen Telegram berukuran kecil, lalu mengunggah beberapa dokumen secara paralel. Setiap dokumen kembali dipecah oleh MTProto menjadi part protokol maksimal 512 KB. Strategi dua tingkat ini mendukung resume, kontrol memori, public download per part, dan pengukuran integritas.

# 2. Latar Belakang dan Masalah

- Penyimpanan cloud konvensional memiliki kuota terbatas atau biaya bulanan.

- Backend yang berjalan di Android/Termux tidak selalu tersedia karena perangkat dapat offline, berpindah jaringan, atau dihentikan Android.

- Vercel dan Netlify serverless tidak cocok menjadi jalur upload video besar karena batas payload dan durasi fungsi.

- Cloudflare Worker tidak dapat menjalankan Local Bot API sebagai daemon persisten.

- Telegram menyediakan penyimpanan media dan API file, tetapi bukan object storage standar; aplikasi harus menyediakan metadata, manifest, retry, integritas, dan UX sendiri.

# 3. Visi Produk

Menyediakan drive pribadi yang sederhana, cepat, mobile-first, dan dapat berjalan tanpa server berbayar: pengguna mengendalikan akun serta channel Telegram mereka sendiri, sementara aplikasi menyediakan lapisan organisasi, pencarian, upload-resume, dan sharing.

# 4. Tujuan

- Mendukung upload file kecil maupun besar tanpa melewati batas payload fungsi Vercel/Worker.

- Menyediakan upload paralel adaptif dan resume setelah browser ditutup, koneksi berpindah, atau sebagian part gagal.

- Menyimpan metadata konsisten di D1 dan isi file di private Telegram channel milik pengguna.

- Memberikan UI mobile-first yang familiar seperti drive: My Drive, Recent, Starred, Shared, dan Trash.

- Berjalan pada Cloudflare Workers Free dan Vercel Hobby untuk penggunaan pribadi/skala kecil.

- Tidak membocorkan Telegram auth key, password 2FA, bot token, atau credential aplikasi ke log/backend yang tidak membutuhkan.

# 5. Non-Tujuan

- Bukan pengganti backup dengan SLA/durabilitas formal seperti Google Drive atau object storage komersial.

- Tidak menjanjikan kompatibilitas S3/WebDAV pada MVP.

- Tidak menyediakan sinkronisasi filesystem desktop pada MVP.

- Tidak melakukan transcoding video, OCR, antivirus scanning, atau thumbnail berat di Worker.

- Tidak menjalankan Local Bot API di Cloudflare Worker.

- Tidak mengakali rate limit atau kebijakan anti-abuse Telegram.

# 6. Persona

| **Persona**           | **Kebutuhan**                                    | **Kriteria keberhasilan**                                  |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Pemilik drive pribadi | Backup foto, dokumen, dan video dari browser     | Upload dapat dilanjutkan, file mudah dicari, download utuh |
| Pengguna mobile       | Upload dari Android dengan jaringan tidak stabil | UI responsif, retry jelas, tidak menghabiskan RAM          |
| Pengelola deployment  | Deploy tanpa server persisten dan tanpa R2       | Setup terdokumentasi, secret aman, monitoring tersedia     |
| Penerima share        | Mengunduh file tanpa akun Telegram               | Tautan aman, expiry, progress, checksum benar              |

# 7. Asumsi dan Keputusan Arsitektur

| **Keputusan**   | **Pilihan**                                  | **Alasan**                                                                      |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Frontend        | React/Next.js static-first di Vercel         | UI dan service worker; file tidak masuk Vercel Function                         |
| Backend         | Cloudflare Worker                            | API ringan, auth, metadata, webhook, share; selalu tersedia                     |
| Database        | Cloudflare D1                                | Metadata relasional, manifest part, transaksi, free tier                        |
| Upload blob     | Browser → Telegram MTProto                   | Menghindari payload serverless dan memungkinkan parallel upload                 |
| Storage target  | Private channel per owner/workspace          | Kontrol akses dan isolasi pesan                                                 |
| Part logis      | Default 16 MiB; dapat dikonfigurasi 8–19 MiB | Di bawah batas download Bot API publik per part dan cukup besar untuk efisiensi |
| Part MTProto    | 512 KiB                                      | Ukuran maksimum/rekomendasi protokol Telegram                                   |
| Public download | HTML share + endpoint per part               | Menghindari batas jumlah subrequest dalam satu Worker invocation                |
| Local Bot API   | Mode opsional di luar scope Worker-only      | Memerlukan host persisten                                                       |

## 7.1 Konsekuensi penting

- Sesi MTProto pengguna hidup di browser, bukan di Worker. Pengguna harus login Telegram pada browser/perangkat baru.

- Upload aktif hanya ketika halaman/PWA mendapat waktu eksekusi. Android/iOS dapat menunda JavaScript saat aplikasi berada di background.

- Part yang sudah menjadi pesan Telegram aman; antrean lokal dan manifest memungkinkan resume saat aplikasi dibuka kembali.

- Public sharing memerlukan bot sebagai admin channel agar webhook menerima pesan part dan menyimpan Bot API file_id.

- Telegram bukan layanan penyimpanan dengan SLA; produk wajib menampilkan peringatan dan mendukung ekspor metadata.

# 8. Ruang Lingkup Rilis

| **Tahap**     | **Termasuk**                                                                                 | **Tidak termasuk**                                                   |
| ------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| MVP           | Single-owner; folder; upload/download; resume; recent; trash; checksum; channel linking; PWA | Public share file besar, multi-user, enkripsi client-side, S3/WebDAV |
| P1            | Public share per part; starred; pencarian; preview umum; adaptive concurrency; multi-device  | Kolaborasi realtime dan office editor                                |
| P2            | Workspace multi-user; role; E2EE opsional; import bot; API token; audit log                  | SLA enterprise                                                       |
| Eksperimental | S3 compatibility gateway dan Local Bot API sidecar                                           | Wajib berjalan di free Worker                                        |

# 9. Alur Pengguna Utama

## 9.1 Onboarding dan linking Telegram

1.  Pengguna membuka aplikasi dan membuat akun aplikasi menggunakan passkey; recovery code diberikan satu kali.

2.  Aplikasi menampilkan instruksi membuat private Telegram channel dan menambahkan bot sebagai admin dengan izin minimum yang diperlukan.

3.  Worker membuat linking code sekali pakai. Pengguna mengirim /link \<code\> kepada bot atau di channel.

4.  Webhook bot mencatat Telegram user/channel ID dan memverifikasi bahwa bot memiliki akses.

5.  Browser memulai login MTProto: nomor telepon, OTP, dan password 2FA bila ada. Credential ini diproses di browser dan tidak dikirim ke Worker.

6.  Session auth key dienkripsi secara lokal menggunakan Web Crypto dan disimpan di IndexedDB; pengguna dapat memilih tidak menyimpan sesi.

7.  Aplikasi melakukan test upload kecil dan menghapus pesan test setelah verifikasi.

## 9.2 Upload file

1.  Pengguna memilih satu atau beberapa file atau melakukan drag-and-drop.

2.  Frontend meminta upload session ke Worker dengan nama, ukuran, MIME type, target folder, lastModified, dan jumlah part yang diproyeksikan.

3.  Web Worker browser menghitung SHA-256 secara incremental dan membagi file menjadi logical chunks default 16 MiB.

4.  Scheduler mengunggah beberapa logical chunk secara paralel. Setiap chunk dikirim ke Telegram melalui MTProto upload.saveBigFilePart/saveFilePart dengan part protokol 512 KiB.

5.  Setelah satu chunk menjadi pesan document di channel, frontend mengirim commit metadata kecil ke Worker.

6.  Worker menyimpan message_id, chunk order, size, hash, Bot API file_id jika sudah tersedia, serta status part di D1.

7.  Saat semua part committed, Worker memvalidasi total ukuran, jumlah part, urutan, dan hash lalu mengubah object menjadi completed.

8.  UI menampilkan selesai hanya setelah manifest final tersimpan; object incomplete tidak muncul sebagai file normal.

## 9.3 Resume upload

1.  Queue dan file handle disimpan di IndexedDB jika browser mendukung File System Access API; fallback meminta pengguna memilih ulang file.

2.  Frontend mengambil upload session dan daftar part committed dari Worker.

3.  Frontend memverifikasi fingerprint file: nama, ukuran, lastModified, dan hash sampel/full hash jika tersedia.

4.  Hanya part missing/failed yang diunggah ulang.

5.  Part dengan nomor sama menggunakan idempotency key sehingga commit ganda tidak menghasilkan manifest duplikat.

## 9.4 Download

- **Pengguna login:** browser mengambil pesan berdasarkan channel/message ID melalui MTProto, memvalidasi hash setiap part, lalu menulis stream ke filesystem.

- **Browser tanpa File System Access API:** gunakan stream saver/service worker; Blob fallback hanya untuk file kecil dengan batas aman.

- **Public share:** halaman share mengambil manifest aman dari Worker lalu mengunduh endpoint part satu per satu; setiap part diproksikan dari Telegram Bot API dan langsung di-stream.

- **Range/preview:** range byte dipetakan ke logical part. Endpoint hanya mengambil part yang bersinggungan dengan range.

# 10. Kebutuhan Fungsional

| **ID**       | **Area**      | **Requirement**                                                                          | **Prioritas** |
| ------------ | ------------- | ---------------------------------------------------------------------------------------- | ------------- |
| FR-AUTH-01   | Akun aplikasi | Sistem menyediakan registrasi/login berbasis passkey dan recovery code.                  | Must          |
| FR-AUTH-02   | Session       | Session aplikasi menggunakan cookie HttpOnly Secure SameSite; CSRF dilindungi.           | Must          |
| FR-TG-01     | Login MTProto | Nomor, OTP, 2FA, dan auth key diproses di client; Worker tidak menerima secret tersebut. | Must          |
| FR-TG-02     | Channel link  | Bot webhook memverifikasi channel, owner, dan permission sebelum digunakan.              | Must          |
| FR-FILE-01   | File browser  | List/grid, breadcrumb, sort, filter, recent, detail file, dan pagination cursor.         | Must          |
| FR-FILE-02   | Folder        | Create, rename, move, soft delete, restore, dan permanent delete.                        | Must          |
| FR-UP-01     | Chunking      | File dibagi 8–19 MiB; default 16 MiB; final part boleh lebih kecil.                      | Must          |
| FR-UP-02     | Parallel      | Concurrency global default 3 logical chunk; adaptif 1–4 berdasarkan network/error.       | Must          |
| FR-UP-03     | Progress      | Tampilkan progress per file, aggregate, speed, ETA, retry, pause, resume, cancel.        | Must          |
| FR-UP-04     | Idempotensi   | Start, commit part, complete, dan abort aman diulang menggunakan idempotency key.        | Must          |
| FR-UP-05     | Resume        | Status part tersimpan lokal dan server; hanya part belum committed yang diulang.         | Must          |
| FR-UP-06     | Integritas    | SHA-256 per part dan full object; mismatch membatalkan completion.                       | Must          |
| FR-DL-01     | Download      | Download streaming, progress, cancel, retry, dan validasi checksum.                      | Must          |
| FR-DL-02     | Range         | Mendukung pemetaan byte range ke logical part untuk preview/resume.                      | Should        |
| FR-SHARE-01  | Share         | Token acak, expiry, optional password, download limit, revoke, dan audit minimal.        | Should        |
| FR-TRASH-01  | Trash         | Soft delete dengan retention default 30 hari dan restore.                                | Must          |
| FR-SEARCH-01 | Search        | Prefix/substring nama, type, date, size, owner; index D1 yang efisien.                   | Should        |
| FR-OPS-01    | Cleanup       | Upload abandoned dan orphan message ditandai; cleanup aman dan dapat diulang.            | Must          |
| FR-EXPORT-01 | Export        | Ekspor metadata/manifest JSON agar recovery tidak bergantung UI.                         | Should        |

# 11. Upload Engine

## 11.1 Strategi part

| **Lapisan**               | **Ukuran**                                                        | **Tujuan**                                        |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| File logis                | Tidak dibatasi oleh aplikasi; dibatasi kemampuan browser/Telegram | Object yang dilihat pengguna                      |
| Logical Telegram document | Default 16 MiB; rentang 8–19 MiB                                  | Unit resume, message Telegram, public download    |
| MTProto upload part       | 512 KiB                                                           | Unit protokol upload.saveFilePart/saveBigFilePart |

## 11.2 Scheduler paralel

- Concurrency logical chunk dimulai pada 2 untuk mobile dan 3 untuk desktop; maksimum 4.

- Masing-masing chunk menggunakan 2–4 antrean MTProto part sesuai kemampuan library dan koneksi.

- Scheduler menurunkan concurrency ketika terjadi FLOOD_WAIT, timeout berulang, memory pressure, atau koneksi seluler lambat.

- Retry memakai exponential backoff + jitter; FLOOD_WAIT selalu menghormati durasi dari Telegram.

- Tidak lebih dari dua file besar diproses aktif sekaligus pada perangkat mobile; file lain antre.

- Prioritas diberikan pada part yang hampir menyelesaikan satu file agar completion cepat dan orphan berkurang.

## 11.3 State machine upload

| **Status** | **Arti**                                  | **Transisi yang diizinkan**        |
| ---------- | ----------------------------------------- | ---------------------------------- |
| created    | Session tercatat, belum ada part          | uploading, aborted                 |
| uploading  | Sebagian part sedang/selesai              | paused, verifying, failed, aborted |
| paused     | Dijeda pengguna/runtime                   | uploading, aborted                 |
| verifying  | Semua part committed; validasi manifest   | completed, failed                  |
| completed  | Object tersedia                           | deleted                            |
| failed     | Butuh retry/intervensi                    | uploading, aborted                 |
| aborted    | Session ditutup; part dijadwalkan cleanup | —                                  |

## 11.4 Performa dan memori

- Gunakan Blob.slice() dan transferable ArrayBuffer; jangan membaca seluruh file ke memory.

- Hashing dilakukan dalam Web Worker agar UI tidak tersendat.

- Maksimum buffer aktif ditargetkan ≤64 MiB desktop dan ≤32 MiB mobile.

- Backpressure wajib: scheduler tidak membaca part berikut sebelum slot upload tersedia.

- Kecepatan dihitung sebagai exponential moving average agar ETA stabil.

# 12. Arsitektur Sistem

| **Komponen**      | **Tanggung jawab**                                                    | **Tidak boleh dilakukan**                                  |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Vercel frontend   | UI, PWA, MTProto client, chunking, hashing, scheduler, IndexedDB      | Memakai Vercel Function sebagai proxy file                 |
| Cloudflare Worker | Auth aplikasi, API metadata, D1, bot webhook, share token, part proxy | Menerima upload file utama atau menyimpan auth key MTProto |
| Cloudflare D1     | User, folder, object, part manifest, upload session, share, audit     | Menyimpan blob file                                        |
| Telegram channel  | Pesan document untuk setiap logical part                              | Menjadi satu-satunya sumber metadata organisasi            |
| Telegram bot      | Channel linking, webhook, capture Bot API file_id, share download     | Memegang sesi user MTProto                                 |
| Browser MTProto   | Login user, upload/download langsung, retry protocol                  | Mengirim OTP/2FA/session ke Worker                         |

## 12.1 Stack yang direkomendasikan

| **Layer**     | **Pilihan awal**                                                                     |
| ------------- | ------------------------------------------------------------------------------------ |
| Monorepo      | pnpm workspace + Turborepo                                                           |
| Frontend      | Next.js/React TypeScript, static/client-heavy, Tailwind atau CSS modules, PWA        |
| MTProto       | Library browser-compatible yang diaudit; wrapper internal agar library dapat diganti |
| State         | TanStack Query untuk server state; Zustand/XState untuk upload queue                 |
| Worker        | TypeScript + Hono; Wrangler; Web Crypto                                              |
| Database      | Cloudflare D1 + migration SQL; query builder ringan                                  |
| Testing       | Vitest, Miniflare/Workers test harness, Playwright, fake Telegram gateway            |
| Observability | Structured JSON logs, Cloudflare analytics, client error boundary                    |

## 12.2 Struktur repository

| **Path**               | **Isi**                                                  |
| ---------------------- | -------------------------------------------------------- |
| apps/web               | Frontend Vercel, PWA, UI drive, MTProto adapter          |
| apps/worker            | Cloudflare Worker API, D1 repository, bot webhook, share |
| packages/contracts     | Schema request/response dan shared types                 |
| packages/upload-engine | Chunk planner, scheduler, retry, hashing, state machine  |
| packages/telegram      | MTProto interface, Bot API interface, fake adapter       |
| packages/crypto        | Session vault, checksum, optional content encryption     |
| migrations             | D1 SQL migrations                                        |
| docs                   | Architecture decision records, runbook, threat model     |

# 13. Model Data D1

| **Tabel**       | **Field inti**                                                   | **Catatan**                     |
| --------------- | ---------------------------------------------------------------- | ------------------------------- |
| users           | id, telegram_user_id, display_name, status, created_at           | Tidak menyimpan session MTProto |
| credentials     | user_id, passkey_credential_id, public_key, counter              | Passkey aplikasi                |
| workspaces      | id, owner_id, name, telegram_channel_id                          | MVP satu workspace              |
| folders         | id, workspace_id, parent_id, name, path_key, deleted_at          | Unique aktif per parent         |
| objects         | id, folder_id, name, mime, size, sha256, part_count, status      | File logis                      |
| object_parts    | object_id, part_no, size, sha256, message_id, bot_file_id        | Unique object_id + part_no      |
| upload_sessions | id, object_id, status, chunk_size, expires_at, idempotency_key   | Resume dan cleanup              |
| shares          | id, object_id, token_hash, expires_at, max_downloads, revoked_at | Simpan hash token               |
| audit_events    | id, actor_id, action, target_type, target_id, created_at         | Tanpa secret/payload file       |

## 13.1 Indeks minimum

- folders(workspace_id, parent_id, deleted_at, name)

- objects(workspace_id, folder_id, status, deleted_at, created_at DESC)

- objects(workspace_id, normalized_name)

- object_parts(object_id, part_no) UNIQUE

- upload_sessions(user_id, status, expires_at)

- shares(token_hash) UNIQUE dan shares(expires_at, revoked_at)

# 14. API Worker

| **Method** | **Endpoint**              | **Fungsi**                                |
| ---------- | ------------------------- | ----------------------------------------- |
| POST       | /v1/auth/passkey/\*       | Registrasi/login passkey                  |
| POST       | /v1/telegram/link         | Membuat linking code                      |
| POST       | /v1/webhooks/telegram     | Webhook Bot API; secret path/header       |
| GET        | /v1/folders/:id/children  | List folder dan object dengan cursor      |
| POST       | /v1/folders               | Membuat folder                            |
| PATCH      | /v1/folders/:id           | Rename/move                               |
| POST       | /v1/uploads               | Membuat upload session                    |
| GET        | /v1/uploads/:id           | Status dan committed parts                |
| PUT        | /v1/uploads/:id/parts/:no | Commit metadata part; tidak menerima blob |
| POST       | /v1/uploads/:id/complete  | Validasi dan complete                     |
| DELETE     | /v1/uploads/:id           | Abort                                     |
| GET        | /v1/objects/:id/manifest  | Manifest untuk owner                      |
| DELETE     | /v1/objects/:id           | Soft delete                               |
| POST       | /v1/objects/:id/restore   | Restore                                   |
| POST       | /v1/objects/:id/shares    | Membuat share                             |
| GET        | /s/:token                 | Metadata share publik                     |
| GET        | /s/:token/parts/:no       | Stream satu part dari Bot API             |

# 15. Keamanan dan Privasi

## 15.1 Secret dan sesi

- TELEGRAM_BOT_TOKEN, APP_SESSION_SECRET, dan webhook secret disimpan sebagai Worker secrets.

- Telegram user auth key tidak pernah dikirim atau disimpan di Worker/D1.

- Auth key lokal dienkripsi menggunakan Web Crypto; key derivation tidak berasal dari nilai hardcoded.

- OTP dan password 2FA hanya berada sementara di memory browser dan dibersihkan setelah login.

- Log melakukan redaction untuk Authorization, cookie, OTP, phone, bot token, file_id sensitif, dan query token share.

## 15.2 Threat model minimum

| **Ancaman**                   | **Mitigasi**                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| XSS mencuri sesi MTProto      | CSP ketat, Trusted Types, tanpa third-party script, dependency pinning, sanitasi, session vault terenkripsi |
| Share token ditebak           | Token CSPRNG ≥128 bit, simpan hash, expiry, rate limit, revoke                                              |
| Manifest dimodifikasi         | Authorization ownership, transaction D1, checksum part dan object                                           |
| Replay commit part            | Idempotency key, unique constraint, compare hash/message ID                                                 |
| Path traversal/nama berbahaya | Nama hanya metadata; encode output; tidak menjadi path server                                               |
| Bot token bocor               | Worker secret, rotation runbook, webhook secret, tidak pernah dikirim ke frontend                           |
| Supply-chain MTProto          | Audit library, lockfile, SBOM, dependabot, wrapper dan integration tests                                    |
| Abuse/flood Telegram          | Per-user quota, adaptive concurrency, FLOOD_WAIT compliance, circuit breaker                                |

## 15.3 Privasi konten

| **Disclosure wajib.** Private Telegram channel bukan end-to-end encrypted storage. Telegram dan pemegang sesi akun secara teknis dapat mengakses media. E2EE client-side menjadi fitur P2; pengguna tetap disarankan menyimpan backup kedua untuk data penting. |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

# 16. Kebutuhan Non-Fungsional

| **Area**      | **Target**                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------- |
| Availability  | API metadata mengikuti availability Worker/D1; tidak ada SLA pada paket gratis               |
| Upload size   | Target uji MVP hingga 2 GiB per file; bukan klaim platform sebelum tes nyata                 |
| Upload speed  | Minimal 80% throughput koneksi efektif pada jaringan stabil setelah warm-up                  |
| Resume        | Tidak mengulang part committed; recovery setelah reload ≤10 detik untuk 10.000 part metadata |
| Memory        | Target ≤64 MiB desktop dan ≤32 MiB mobile untuk buffer upload aktif                          |
| UI            | Input tetap responsif; long task \>50 ms dipantau                                            |
| Integrity     | 100% part diverifikasi; full checksum tersedia setelah completion                            |
| Accessibility | WCAG 2.1 AA untuk alur inti; keyboard, focus, contrast, screen reader                        |
| Compatibility | Chrome/Edge modern prioritas; Android Chrome; Safari/iOS dengan fallback                     |
| Localization  | Bahasa Indonesia awal; string siap i18n                                                      |

# 17. Batas Free Tier dan Guardrail

| **Layanan**  | **Batas relevan**                                               | **Guardrail produk**                                             |
| ------------ | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Workers Free | 100.000 request/hari; subrequest terbatas; runtime bukan daemon | Blob upload bypass; batch metadata; part share per request       |
| D1 Free      | 500 MB/database; 5 juta row read dan 100 ribu row write/hari    | Index semua list/search; cursor; cleanup; metrics                |
| Vercel Hobby | Function payload terbatas                                       | Frontend static/client-heavy; tidak membuat upload API di Vercel |
| Telegram     | Rate limit, flood wait, kebijakan penggunaan, batas dinamis     | Adaptive concurrency, transparansi, tidak menjanjikan unlimited  |

# 18. UX dan Informasi Layar

| **Layar**             | **Komponen utama**                                                                 |
| --------------------- | ---------------------------------------------------------------------------------- |
| Login                 | Passkey, recovery, status koneksi Telegram                                         |
| Onboarding            | Create channel, add bot, link code, MTProto login, test storage                    |
| My Drive              | Sidebar, breadcrumb, list/grid, sort, filter, upload CTA, quota indicator metadata |
| Upload drawer         | Queue, progress, speed, ETA, part status, pause/resume/cancel/retry                |
| File detail           | Preview, metadata, checksum, parts, download, share, activity                      |
| Recent/Starred/Shared | Filter virtual tanpa duplikasi blob                                                |
| Trash                 | Retention countdown, restore, delete permanently                                   |
| Settings              | Telegram session/device, channel, concurrency, chunk size, export metadata, revoke |

## 18.1 Prinsip UX upload

- File muncul segera sebagai uploading placeholder, tetapi tidak dapat dibagikan sampai completed.

- Error menyebut part dan tindakan yang dapat dilakukan; jangan hanya menampilkan 405/500.

- Pause menghentikan pembacaan part baru; request yang hampir selesai boleh diselesaikan.

- Perubahan jaringan otomatis mem-pause singkat lalu retry; mode hemat data dapat memblokir seluler.

- PWA menampilkan peringatan bahwa browser mobile dapat menghentikan upload di background.

# 19. Observability dan Operasional

- Setiap API request memiliki request_id; upload session dan object ID boleh dicatat, secret tidak.

- Metric: upload started/completed/failed/aborted, part retry, checksum mismatch, Telegram error code, D1 latency, share download.

- Dashboard client: throughput, concurrency, part latency, memory estimate, online/offline transitions.

- Alert sederhana: error rate \>10%, webhook gagal, D1 quota mendekati batas, orphan meningkat.

- Runbook: rotate bot token, restore D1 Time Travel, relink channel, rebuild manifest, cleanup orphan.

# 20. Strategi Pengujian

## 20.1 Unit dan contract test

- Chunk planner untuk ukuran 0 B, tepat batas, final part kecil, dan file sangat besar.

- Scheduler, backpressure, adaptive concurrency, retry, pause/resume/cancel.

- State machine menolak transisi ilegal dan completion tanpa semua part.

- Checksum per part/full file dan deteksi korupsi.

- Authorization, token share, expiry, limit download, idempotency, CSRF.

- D1 migrations dan query plans untuk list/search.

## 20.2 Integration dan end-to-end

| **Skenario**                                 | **Ekspektasi**                                                 |
| -------------------------------------------- | -------------------------------------------------------------- |
| 1 MiB, 10 MiB, 25 MiB, 100 MiB, 1 GiB, 2 GiB | Upload dan download selesai; SHA-256 sama                      |
| Putus internet pada 10%, 50%, 90%            | Resume hanya part missing                                      |
| Reload/tab crash                             | Queue dipulihkan; konfirmasi file jika handle tidak tersedia   |
| Part commit dikirim dua kali                 | Satu row, tidak ada duplikasi object size                      |
| Telegram FLOOD_WAIT                          | Menunggu sesuai server; UI memberi status                      |
| D1 sementara gagal                           | Part Telegram tidak hilang; commit metadata dapat diulang      |
| Message Telegram dihapus manual              | Download mendeteksi missing part dan memberi recovery guidance |
| Range lintas dua logical part                | Byte tepat dan status/header benar                             |
| Share expired/revoked/limit habis            | Akses ditolak tanpa membocorkan metadata                       |
| Android background                           | Peringatan jelas; resume setelah foreground                    |

## 20.3 Matriks browser

| **Platform**   | **Prioritas** | **Catatan**                                             |
| -------------- | ------------- | ------------------------------------------------------- |
| Chrome desktop | P0            | File System Access API dan Web Worker penuh             |
| Chrome Android | P0            | Background throttling dan memory rendah                 |
| Edge desktop   | P1            | Setara Chromium                                         |
| Safari macOS   | P1            | Fallback download dan IndexedDB                         |
| Safari iOS     | P1            | Batas background paling ketat; file picker/resume diuji |
| Firefox        | P2            | Fallback File System Access                             |

# 21. Acceptance Criteria MVP

- Deployment baru dapat dibuat dari dokumentasi tanpa fork project lain.

- Frontend dapat di-deploy ke Vercel dan Worker/D1 ke Cloudflare Free tanpa R2.

- Pengguna dapat membuat folder, upload, rename, move, download, soft delete, restore, dan permanent delete.

- File 1 MiB, 25 MiB, 100 MiB, dan sedikitnya 1 GiB berhasil round-trip dengan SHA-256 identik pada lingkungan uji.

- Memutus koneksi lalu membuka ulang aplikasi tidak mengulang part yang sudah committed.

- Tidak ada request blob file utama menuju domain Vercel Function atau Worker API.

- OTP, password 2FA, dan auth key MTProto tidak terlihat pada log Worker/D1.

- Upload concurrency dapat dikonfigurasi dan tidak membuat UI freeze pada perangkat target.

- Manifest D1 dapat diekspor dan digunakan untuk memverifikasi seluruh pesan part.

- Semua keterbatasan Telegram dan tidak adanya SLA ditampilkan saat onboarding.

# 22. Roadmap Implementasi

| **Fase**          | **Deliverable**                                                       | **Exit criteria**                                   |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| 0 — Spike         | Proof MTProto browser, login, upload/download 16 MiB, channel message | Berjalan di Vercel preview; secret tidak ke backend |
| 1 — Foundation    | Monorepo, Worker, D1 migrations, passkey, channel linking             | CI hijau dan deployment repeatable                  |
| 2 — Upload engine | Chunking, parallel scheduler, progress, retry, checksum               | 100 MiB round-trip dan memory target                |
| 3 — Drive UX      | Folder, list/grid, recent, trash, details                             | Alur utama usable mobile/desktop                    |
| 4 — Resilience    | IndexedDB queue, resume, orphan reconciliation, export                | Crash/network tests lulus                           |
| 5 — Sharing       | Share token, part endpoint, range, password/expiry                    | Public download terukur dan aman                    |
| 6 — Hardening     | Threat model, CSP, rate limit, observability, runbook                 | Security checklist dan load test lulus              |

# 23. Risiko dan Mitigasi

| **Risiko**                             | **Dampak**                      | **Mitigasi**                                                                    |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| MTProto library browser tidak stabil   | Upload gagal/maintenance tinggi | Spike lebih dulu, adapter abstraction, pin version, fake gateway                |
| XSS mencuri sesi Telegram              | Kompromi akun                   | CSP keras, tanpa third-party JS, audit dependency, session vault, logout remote |
| Browser background dihentikan          | Upload tertunda                 | Resume kuat, PWA warning, Wake Lock best effort                                 |
| Telegram mengubah limit/kebijakan      | Throughput/availability turun   | Config dinamis, rate compliance, export, storage adapter future                 |
| Pesan/channel dihapus manual           | Part hilang                     | Health check, missing-part report, backup kedua                                 |
| D1 metadata hilang                     | File sulit ditemukan            | Time Travel, export berkala, reconstruction tool                                |
| Public share terlalu banyak subrequest | Download gagal                  | Endpoint satu part per request, client assembly, rate limit                     |
| File sangat besar memakan banyak row   | D1 quota                        | 16–19 MiB logical part, pagination dan cleanup                                  |

# 24. Pertanyaan untuk Review

1.  Apakah MVP hanya untuk satu pemilik atau sejak awal harus mendukung banyak akun/workspace?

2.  Apakah pengguna bersedia login Telegram langsung di browser menggunakan nomor, OTP, dan 2FA?

3.  Apakah ukuran logical part 16 MiB disetujui untuk menyeimbangkan jumlah pesan dan public download?

4.  Apakah public sharing wajib di MVP atau cukup setelah upload/download owner stabil?

5.  Apakah file harus dienkripsi client-side sebelum Telegram, dengan konsekuensi preview dan sharing lebih kompleks?

6.  Apakah target file maksimum awal 2 GiB cukup, atau harus membuktikan ukuran lebih tinggi?

7.  Apakah UI hanya web/PWA atau perlu aplikasi Android native di fase berikutnya?

8.  Apakah kompatibilitas S3/WebDAV benar-benar diperlukan atau UI drive menjadi satu-satunya client?

9.  Apakah Vercel Hobby akan digunakan hanya untuk penggunaan personal/non-komersial?

# 25. Sumber Teknis

- Telegram — Uploading and Downloading Files: https://core.telegram.org/api/files

- Telegram — Bot API: https://core.telegram.org/bots/api

- Cloudflare Workers — Limits: https://developers.cloudflare.com/workers/platform/limits/

- Cloudflare Workers — TCP sockets: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

- Cloudflare D1 — Limits: https://developers.cloudflare.com/d1/platform/limits/

- Cloudflare D1 — Pricing/free quotas: https://developers.cloudflare.com/d1/platform/pricing/

- Vercel — Functions limitations: https://vercel.com/docs/functions/limitations

# Lampiran A — Aturan Error

| **Kode aplikasi**    | **Kondisi**                        | **Pesan pengguna**                                               |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| TG_AUTH_REQUIRED     | Session MTProto tidak tersedia     | Hubungkan kembali akun Telegram untuk melanjutkan.               |
| TG_FLOOD_WAIT        | Telegram meminta jeda              | Upload dijeda sementara dan akan dilanjutkan otomatis.           |
| PART_HASH_MISMATCH   | Checksum part berbeda              | Satu bagian file rusak dan akan diunggah ulang.                  |
| PART_MESSAGE_MISSING | Pesan Telegram tidak ditemukan     | Sebagian file tidak tersedia di channel penyimpanan.             |
| UPLOAD_EXPIRED       | Session upload kedaluwarsa         | Pilih file yang sama untuk melanjutkan atau mulai ulang.         |
| CHANNEL_PERMISSION   | Bot/user tidak punya izin          | Periksa admin dan izin posting pada channel.                     |
| D1_QUOTA             | Batas free tier mendekati/tercapai | Layanan metadata sementara dibatasi; coba kembali setelah reset. |

# Lampiran B — Definition of Done

- Requirement memiliki test atau acceptance check.

- Tidak ada TypeScript error, lint error, migration drift, atau secret pada repository.

- Unit, integration, dan E2E utama lulus di CI.

- Upload/download diuji dengan checksum dan bukti ukuran nyata.

- UI mobile dan desktop diperiksa untuk loading, empty, error, offline, dan retry state.

- Logging telah melalui redaction test.

- Dokumentasi deployment, rollback, recovery, dan limit diperbarui.

- Perubahan keamanan direview terhadap threat model.
