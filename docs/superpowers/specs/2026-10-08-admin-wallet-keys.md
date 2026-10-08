# Admin wallet adjustment (TOPUP only) + admin key grant/revoke

Status: NORMATIVE SPEC — awaiting written user approval. No implementation before approval.
Supersedes `admin-controls-final.md`. HEAD at writing: `5d632aa2`. Instance-admin-only throughout.

## 1. Money invariants (non-negotiable)

Integer VND. Ledger append-only. Every adjustment = ONE transaction: wallet FOR UPDATE lock → calculate → wallet CAS update + ledger row + claim (receipt) row + audit row → commit all or none. No `creditWallet` null-payment dedup shortcut; no direct `balance` write. Claim-row UNIQUE(actor, key) is the replay arbiter.

## 2. DB: `admin_wallet_adjustments` (new forward-only migration, registered in `packages/db/src/drizzle/meta/_journal.json`)

```text
id                 text PK (crypto.randomUUID)
actor_user_id      text NOT NULL (instance admin)
idempotency_key    text NOT NULL (client-supplied, 16..128 chars)
wallet_id          text NOT NULL FK wallets.id
workspace_id       text NOT NULL FK workspaces.id
delta              bigint NOT NULL  (signed, != 0, |delta| <= MAX_BOUND; ledger.amount = |delta|)
reason             text NOT NULL (1..500, ADMIN-PRIVATE)
balance_before     bigint NOT NULL  (receipt, persisted)
balance_after      bigint NOT NULL  (receipt, persisted)
reserved           bigint NOT NULL  (receipt, persisted — reserved balance snapshot at adjustment time;
                                     REQUIRED so the response/replay can return `reserved` without recompute)
ledger_entry_id    text NULL FK ledger_entries.id  (set later in SAME txn)
request_payload    jsonb NOT NULL ({ workspaceId, delta, reason })  (replay compare source)
created_at         bigint NOT NULL

UNIQUE (actor_user_id, idempotency_key)
```

- UNIQUE is `(actor_user_id, idempotency_key)`, not key alone: different actors may reuse a client key.
- `ledger_entry_id` is nullable and set after the ledger insert, in the same transaction. **Postgres cannot enforce "non-null at commit" for this column declaratively** (no partial-CHECK-on-commit, and no cross-table CHECK is attempted — a CHECK referencing `ledger_entries` is invalid). The guarantee is structural: the single transaction sequence in §3 always performs step 7 before commit, and regression test T1b (audit-failure injection → full rollback) proves a partially written claim can never survive. This is an application-enforced invariant, stated as such.
- `balance_before`/`balance_after`/`reserved`/`request_payload` are persisted so replay returns the ORIGINAL result without recomputation.

## 3. Transaction sequence (exact)

1. (Outside txn) validate body: `delta` signed safe integer ≠ 0 via `Number.isSafeInteger`; `reason` 1..500; key 16..128.
2. BEGIN → `lockWallet(tx, walletId)` FOR UPDATE (single-row lock; one lock per txn → no lock-order cycle, even for concurrent same-key requests on different wallets).
3. Read wallet (balance, reserved, version).
4. INSERT claim row — UNIQUE arbitration point; all receipt values (`balance_before`, `reserved`, `request_payload`) are real here, no placeholders.
5. Compute `balance_after`: credit → `overflowCheckedAdd`, reject > MAX_SAFE_INTEGER / MAX_BOUND → **409 `OVERFLOW`**; debit → require `balance + delta >= reserved` else **409 `INSUFFICIENT`**.
6. CAS `UPDATE wallets SET balance, version+1 WHERE id AND balance=? AND version=?` (0 rows = concurrent change → throw, rollback).
7. INSERT ledger row (`direction` = sign of delta, `kind='adjustment'`, `amount=|delta|` > 0 per `ledger_amount_type`, `balance_after`, memo = constant `'Admin adjustment'`).
8. `UPDATE admin_wallet_adjustments SET ledger_entry_id` (same txn; FK satisfied because the ledger row already exists in-txn).
9. `writeAudit(tx, { actorUserId, workspaceId, action:'admin.wallet.adjust', target: walletId, detail: { delta, reason } })`.
10. COMMIT.

**Concurrent same key** (same or different wallets): step 4's UNIQUE arbitrates. The loser's transaction aborts on unique violation (SQLSTATE 23505) → ALL loser writes (any claim insert, CAS, ledger, audit) roll back together. The loser then re-reads the committed claim OUTSIDE the aborted transaction: `request_payload` matches → return the stored receipt with `replayed:true`; mismatched → **409 `IDEMPOTENCY_MISMATCH`**. Replay is a read-only path; no re-execution. Winner's locks release at commit.

No double credit: claim row exists ⇔ ledger row exists ⇔ wallet updated, atomically.

## 4. API — `POST /api/v1/admin/workspaces/:workspaceId/wallet/adjust`

- Guard: `requireSession` + `requireInstanceAdmin` (`authz.ts:25,67`). Workspace membership NOT required; instance-admin routes never widen workspace routes.
- Body: `{ delta, reason, idempotencyKey }`. Wallet = the workspace's `kind='topup'` wallet (**TOPUP ONLY**; subscription wallet never addressed — resolves to 404 if absent). `walletId`/`userId` never accepted from the client.
- Response (original and replay identical): `{ ledgerEntryId, balanceBefore, balanceAfter, reserved, workspaceId, replayed }` — `reserved` is the persisted claim snapshot (§2); on replay every field comes from the persisted claim row.
- Errors: **400** invalid body | **401** | **403** non-instance-admin (incl. workspace owner) | **404** wallet/workspace missing | **409 `INSUFFICIENT` | `OVERFLOW` | `IDEMPOTENCY_MISMATCH`** | CAS miss → one transparent retry, else **503**.

## 5. UI — Admin Users page (`apps/web/src/pages/admin/users.tsx`)

- "Adjust wallet" dialog: EXPLICIT workspace picker (all workspaces of the user via memberships fetch; never assume one personal wallet). Shows workspace name + current topup balance + reserved.
- Form: credit/debit toggle + positive amount (UI composes signed delta), required reason, confirm step `balanceBefore → balanceAfter`.
- Post-submit: show before/after + link to the ledger entry in workspace wallet history. Actor email + reason visible ONLY to instance admins via the audit route, never to workspace members or workspace admins.

## 6. Privacy defaults (approved; no open questions)

- **Reason is ADMIN-PRIVATE**: stored in `admin_wallet_adjustments.reason` + audit detail. Workspace ledger `memo` = constant `'Admin adjustment'`. Non-admin ledger reads show no actor, no reason. The audit endpoint is the existing dual-scoped `GET /api/v1/audit` (`apps/api/src/routes/audit.ts:170`) — there is NO `/api/v1/admin/audit`.
- **Audit scoping (P1 contract)**: the workspace-scoped branch of `/api/v1/audit?workspace_id=X` currently lets workspace admin/owner of X read rows with `detail` verbatim. REQUIRED: when the requester is NOT an instance admin, rows with action `admin.wallet.adjust` and the new `admin.key.*` actions MUST be EXCLUDED by an SQL predicate applied BEFORE pagination (`before` cursor), count/limit computation, and enrichment — so the private reason and actor are unobtainable through any query variant (including `action=` prefix filters and pagination cursors). Instance-admin audit access (no `workspace_id` filter, or filtered as instance admin) retains the FULL authorized record, including reason and actor email. Existing workspace-auth restrictions (`requireWsRole(db, wsId, userId, "admin")` in the workspace branch, `requireInstanceAdmin` in the global branch) stay UNCHANGED. No other audit record is redesigned; only these new privileged support events are scoped.
- Key material: hashed only (`api_keys.key_hash` UNIQUE, `key_prefix`); plaintext returned exactly once at grant, never logged/stored/emailed/recoverable; no GET returns it. History soft-delete (`deleted_at`) only.

## 7. API — Admin keys (`apps/api/src/routes/admin-keys.ts`, new; workspace routes at `keys.ts` UNCHANGED, still `requireWsRole`-gated; instance admin gets nothing there)

- `GET /api/v1/admin/workspaces/:workspaceId/keys` — list: id, name, key_prefix, status, created_at, last_used_at, modelIds. **Generic purpose only** (`purpose='generic'`); no hashes/plaintext.
- `POST /api/v1/admin/workspaces/:workspaceId/keys` — body `{ name, modelIds?: string[] }`. Every modelId must exist in `models` (same check as `keys.ts:313-321`); empty/absent = unrestricted, surfaced explicitly in confirm. Generic purpose only. One txn: insert key + allowlist rows + audit `admin.key.grant` `{ keyId, modelIds }`. Response includes `plaintext` once. UI: explicit confirmed-intent step ("shown once, cannot be recovered") with copy.
- `POST /api/v1/admin/workspaces/:workspaceId/keys/:keyId/revoke` — body `{ reason }` REQUIRED. Verify the key belongs to `:workspaceId` → **404** otherwise. Terminal `status='revoked'`, `revoked_at=now`. Idempotent: already revoked → 200 `{ status:'revoked' }`, no second audit. Audit `admin.key.revoked` `{ keyId, reason }` on the first revoke only. Gateway rejects revoked keys immediately (existing).

## 8. Tests (behavior-level, root `tests/`)

- T1a Credit/debit happy path: exact `balance_before/after/reserved` persisted, one ledger row (`amount=|delta|`>0), one audit row, claim `ledger_entry_id` non-null after commit.
- T1b Audit-failure injection → ALL writes rolled back (proves the §2 non-null-at-commit invariant as far as testable).
- T2 Replay: same actor+key+identical payload → stored receipt incl. `reserved`, `replayed:true`, single ledger row. Same actor+key, changed delta/reason/workspace → 409 `IDEMPOTENCY_MISMATCH`, no writes.
- T3 Concurrent same key, different wallets (two parallel requests): exactly one commits; loser replays/mismatches safely; no partial rows, no deadlock.
- T4 Concurrent adjust vs `settleRequest` (`packages/wallet/src/billing.ts:416`): no lost update, correct `balance_after` (CAS + FOR UPDATE).
- T5 Concurrent adjust vs `reserveRequest` hold: `reserved` untouched; debit blocked when it would breach `balance >= reserved` (409 `INSUFFICIENT`); DB CHECK backstop on wallets unchanged.
- T6 Replay race of N parallel identical requests → exactly one ledger row; no concurrent double-spend on the same wallet.
- T7 Overflow: credit at MAX_BOUND → 409 `OVERFLOW`, zero writes.
- T8 Auth negatives: workspace owner/member (non-instance-admin) → 403 on adjust + admin keys; instance admin non-member → 200; anonymous → 401; non-admin ledger read shows generic memo, no actor/reason. Audit privacy: workspace admin/owner querying `/api/v1/audit?workspace_id=X` (any variant: bare, `action=admin.` prefix, `action=admin.wallet.adjust`, with `before`/`limit` cursors) receives NO `admin.wallet.adjust` or `admin.key.*` rows — no `detail.reason`, no `detail.delta`, no actor email, and pagination totals/next-cursor computed AFTER the exclusion; the SAME query as instance admin returns the full record with reason and actor.
- T9 Keys: unknown modelId → 400; plaintext in grant response only, absent from all GETs and logs; revoke idempotent (one audit row); wrong-workspace revoke → 404; revoked key rejected at gateway; admin calling workspace key route (non-member) → 403 unchanged.
- T10 Scope: subscription wallet unreachable (adjust resolves topup only).

## 9. Implementation files (future, one PR per contract)

- Contract 1: `packages/db/src/schema.ts` + migration + `_journal.json`; `packages/wallet/src/wallet.ts` (`adjustWalletBalance` reusing `lockWallet`/`runInImmediate`); new `apps/api/src/routes/admin-wallet-adjust.ts`; `apps/web/src/pages/admin/users.tsx`; tests T1–T8, T10.
- Contract 2: new `apps/api/src/routes/admin-keys.ts` (reuse key-gen/hashing from `keys.ts`); `apps/api/src/routes/audit.ts` (workspace-scoped branch: exclude `admin.wallet.adjust` + `admin.key.*` rows for non-instance-admins before pagination/count/enrichment); admin UI entry; tests T9, T8-audit.
