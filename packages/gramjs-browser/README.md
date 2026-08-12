# `@teledrive/gramjs-browser`

Phase 2 planner-only seam around vendored `telegram@2.26.22`.

## Status and source of truth

Direct runtime is **unavailable**. `src/index.ts` exports pure transfer planning,
contracts, retry, and file-reference policy only. It deliberately does not import,
execute, transpile, bundle, or re-export vendored runtime code. No production path
may depend on this private package.

B2.2b adds synthetic auth state-shape simulation only: opaque project-authored
fixtures, with no crypto, auth key, TL codec, transport, or live-runtime claim.

B2.2c adds a synthetic, pure opaque-frame queue/lifecycle reducer; no browser API,
socket, endpoint, framing, traffic, or runtime proof.

B2.2e adds a zero-network, test-only opaque-lane simulation; it is not browser API, endpoint, traffic, framing, or runtime evidence.

Raw-core wipe ceiling: `Session.clear()` zeroes session key/keyId in memory on a
best-effort basis, but JavaScript cannot guarantee hardware or memory wipe across
GC and uncontrolled copies. Mitigate with ephemeral sessions per cloud file; never
persist key material.

`vendor/telegram-2.26.22.tgz` is immutable artifact source of truth. `UPSTREAM.json`
records its npm URL, SHA-512/SHA-1 hashes, registry-advertised `gitHead`, publish
timestamp, and audit timestamp. The registry `gitHead` is metadata only: the public
commit is unreachable and no GitHub commit/source-tree equivalence is claimed.
Extracted files under `vendor/telegram-2.26.22/` are compared file-by-file against
the gzip tarball offline. No extracted-tree hash is claimed: tar member order,
metadata, and filesystem extraction details are not a stable substitute for tarball
bytes.

Upstream license notice remains at `vendor/telegram-2.26.22/LICENSE`; project
distribution notice is `NOTICE`.

## Package checks

From repository root:

```bash
pnpm --dir packages/gramjs-browser verify:provenance
pnpm --dir packages/gramjs-browser test
pnpm --dir packages/gramjs-browser typecheck
pnpm --dir packages/gramjs-browser browser:graph
pnpm --dir packages/gramjs-browser scope:check
pnpm --dir packages/gramjs-browser tl:verify
pnpm --dir packages/gramjs-browser tl:check
pnpm --dir packages/gramjs-browser tl:graph
```

## Phase 2B.1 TL evidence

Signed Git tag `tl-supply-chain-b1-v4` anchors B1 supply-chain paths only:
`tl/**`, `tools/tlgen/**`, exact B1 scripts, and TL supply-chain test.
Verification requires exact signed tag and matching protected worktree. Raw-core
work gets separate review/release anchor; this tag makes no raw-core approval
claim.

API Layer 223 is metadata-only at project capture. MTProto is an unlayered
snapshot static declaration codec. Both are project-captured, unsigned, and
make no canonical-generator or GramJS-equivalence claim. Three ledgers remain
separate: raw captures, policy/composition, and generated artifacts.

Terms: https://core.telegram.org/api/terms

Updates and rollback use immutable new capture/generated directories; existing
directories are never silently repointed. Direct runtime, authentication,
transport, upload, and download paths are blocked.

The verifier reads metadata, required files, and tarball bytes only. It performs no
network access and never imports or executes vendor code.

## Phase 2 planner boundary

- Object size is at most 10 GiB, split into at most 160 fixed 64 MiB logical documents.
- Each logical document exposes a lazy sequence of Telegram protocol chunks no larger
  than 512 KiB. Planner validates the selected live-config file-part cap per logical
  document; it does not treat that cap as an object-level logical-part cap.
- `source: "mock"` is test evidence only and remains `mock` in every plan. Live config
  RPC, authentication, upload, download, browser transport, and persistence are absent.
- Eventual caller must supply independent signed 64-bit Telegram `fileId` and
  `randomId` values, plus a separate CSPRNG extensionless random filename with at
  least a 128-bit encoding; all three remain immutable across retries, reconciliation,
  and file-reference refresh.
- `upload.saveFilePart` carries only `fileId`, `partIndex`, and `bytes`. Final small
  `InputFile` descriptors require whole-file MD5; `InputFileBig` descriptors do not.
- Browser graph check is a static source import guard, not a browser bundle or live
  runtime proof. Phase 2B must audit a project-owned browser core before direct transfer.
- Scope check searches web/Worker source and package manifests for references to this
  private package. It is an import-boundary check, not a production bundle proof.
- `Session.clear()` uses in-memory zero-fill (`fill(0)`); this cannot guarantee removal from JS heap memory after GC/compaction, with upgrade path of one-shot session buffers without chained copies or one Worker isolate per session.

## Browser audit checklist

- [ ] Deny Node-only `fs` and related filesystem adapters in eventual browser runtime.
- [ ] Deny SOCKS, Node socket, and implicit network backends; browser transport must be explicit.
- [ ] Deny implicit persistence (`store2`, local filesystem, Cache API, IndexedDB, or equivalent) until reviewed.
- [ ] Deny code generation (`eval`, `new Function`, runtime TL/module generation, or equivalent).
- [ ] Audit whole-file `Buffer` behavior before accepting upload/download paths; current snapshot is not evidence of streaming.
- [ ] TL baseline is layer **198**. Inventory `tl/AllTLObjects`, `api`, `apiTl`, `index`, `MTProtoRequest`, `schemaTl`, `core/`, `custom/`, `patched/`, and `types-generator/`.
- [ ] Explicitly audit `tl/generationHelpers.js` and `tl/generateModule.js`; `tl/static` build inputs are absent, so the TL source build cannot be reproduced from this snapshot alone.
- [ ] Generated helpers must not become runtime code-generation dependencies.
- [ ] Record browser-safe crypto, WebSocket, byte-array, cancellation, and large-file streaming boundaries.
- [ ] Review transitive imports for Node shims, persistence, dynamic loading, and hidden side effects.

## Patch and release ownership

- Package maintainer and provenance owner `Gia Fauzan` records npm package/version, exact tarball URL, hashes, source timestamp, and audit timestamp in `UPSTREAM.json`.
- License owner `Gia Fauzan` preserves upstream `LICENSE`/copyright and updates `NOTICE` when redistribution scope changes.
- Validation owner `Gia Fauzan` runs provenance, package tests, and typecheck; no vendor code is executed by provenance checks.
- Telegram-layer/update owner `Gia Fauzan` reviews vendor diff, TL layer 198, and browser audit checklist before any source seam imports vendor code.
- Reproducible-build owner `Gia Fauzan` verifies byte-identical tarball input and records any repackaging step separately; no generated vendor bundle is accepted as source truth.
- Release owner `Gia Fauzan` coordinates Oracle/reviewer approval gate for runtime, TL, transport, storage, and release changes before production dependency or application import is added.
