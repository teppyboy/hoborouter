# Research: Vietnam Payments (VietQR / payOS / VNPay / MoMo) — MVP mock payment flow design

## What investigated

Official docs for VietQR (vietqr.io quick-link/generate API, api.vietqr.vn Pro callbacks), payOS (webhook confirm/verify), VNPay (IPN + HMAC SHA512), MoMo (HMAC_SHA256 signature + IPN), plus QR spec (EMV Merchant-Presented, NAPAS).

## Files changed

- (research only) This brief. No repo files edited.

## Findings

1. **Claim:** VietQR.io offers an unauthenticated-ish "Quick Link" static QR image URL (`https://img.vietqr.io/image/<BANK_ID>-<ACCOUNT_NO>-<TEMPLATE>.png?amount=&addInfo=&accountName=` — the `-<TEMPLATE>` segment is optional and defaults, e.g. `qr_code`/`compact2`) and a generate API (`POST https://api.vietqr.io/v2/generate` with `x-client-id`/`x-api-key`; the older `/v1/generate` with only `x-api-key` seen in the legacy GitHub sample is version-dependent/legacy). QR generation is free/cheap; **QR generation alone gives no payment confirmation**. **Sources:** [Quick Link](https://www.vietqr.io/en/danh-sach-api/link-tao-ma-nhanh/), [API tạo mã QR](https://www.vietqr.io/en/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr/). **Support:** direct evidence (current official docs); independently audited. **Confidence:** high.

2. **Claim:** Payment confirmation via VietQR requires extra plumbing: api.vietqr.vn Pro uses a partner-implemented **Get Token API + Transaction Sync webhook** (VietQR pushes balance-change events, `bankaccount`/`amount`/`transType`) — you must host an authenticated endpoint. **Sources:** [Workflow](https://api.vietqr.vn/en/vn/overview/description-of-vietqr-api-workflow), [API Transaction Sync](https://api.vietqr.vn/en/vn/api-vietqr-callback/api-transaction-sync). **Support:** direct evidence. **Confidence:** high. _Implication (inference):_ static QR + manual confirmation is genuinely the zero-integration MVP stage; matching by `addInfo`/amount is heuristic only.

3. **Claim:** payOS webhooks: register via `POST /confirm-webhook` (payOS sends a test payload; endpoint must respond 2XX), then verify incoming payload's `signature` with the merchant `checksum key` — HMAC-SHA256 of the payload string compared against `signature`, documented at [Kiểm tra dữ liệu với signature](https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature.md) (`hash_hmac("sha256", $transaction_str, $checksum_key)`). Payload: `{code, desc, success, data{orderCode, amount, description, reference, transactionDateTime,...}, signature}`. SDKs (node/python/go) provide `webhooks.confirm()`/`verify()`. **Sources:** [payOS webhook docs](https://payos.vn/docs/du-lieu-tra-ve/webhook/), [payOS API](https://payos.vn/docs/api/), [payos-lib-node](https://github.com/payOSHQ/payos-lib-node). **Support:** direct evidence. **Confidence:** high. `orderCode` (unique per payment link) is the natural idempotency key.

4. **Claim:** VNPay: payment URL + IPN callback; verify `vnp_SecureHash` = HMAC_SHA512 over sorted, URL-encoded params using the merchant hash secret. Community sandbox at `sandbox.vnpayment.vn`. **Sources:** [sandbox docs](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html), [vnpay.js verify IPN](https://vnpay.js.org/en/ipn/verify-ipn-call). **Support:** direct evidence (secondary for exact canonicalization order — recheck during integration). **Confidence:** medium-high.

5. **Claim:** MoMo: HMAC_SHA256 `signature` over `key=value&...` concatenations for every request/response including the IPN (Notification). Per-endpoint signature field allowlists. **Sources:** [Digital Signature](https://developers.momo.vn/v3/docs/payment/api/other/signature/), [Notification](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/). **Support:** direct evidence. **Confidence:** high.

6. **Claim:** Vietnamese bank/e-wallet QR follows EMV QR Code Merchant-Presented Mode v1.1 (NAPAS network); static QR is a fixed string, so amount/description cannot be enforced by the QR itself. **Source:** [QR spec summary](https://github.com/khanhuyy/emvgo/blob/main/docs/QR_SPEC.md). **Support:** direct evidence. **Confidence:** medium-high (secondary source summarizing EMVCo).

## Decisions (evidence-based MVP payment flow, decoupled from ledger billing)

1. **Stage 0 (now): mock payment provider.** Internal `MockPaymentProvider` emitting the _same event shape as payOS webhooks_ (`code/desc/success/data{orderCode, amount, ...}`) so stage 1 is a provider swap, not a redesign. Event shape chosen = payOS because it is the simplest documented, signature-verified webhook among the four.
2. **Stage 1: static VietQR + manual/semi-manual confirmation.** Generate QR via Quick Link (no credentials needed for image URL) with `addInfo` = order code; admin/expiring-pending flow marks paid. No automated confirmation exists at this stage — this is a known, accepted limitation.
3. **Stage 2: merchant API.** payOS first (simplest webhook verify); VNPay/MoMo behind same provider interface later.
4. **Payments ≠ ledger billing:** payments module emits `payment.succeeded`/`payment.failed` events keyed by immutable `paymentId` + provider `reference`; ledger consumes events idempotently. Never write ledger rows from webhook handlers directly.
5. **Idempotency:** dedupe on provider `orderCode` + `reference`; webhook handlers must be at-least-once safe.
6. **Security:** always verify signature (payOS `signature` via checksum key; VNPay HMAC-SHA512; MoMo HMAC-SHA256), validate `amount` matches the order server-side, respond 2XX only after accept, store raw webhook payload for audit/replay.

## Problems / risks

- Static QR cannot auto-confirm; manual matching by amount/`addInfo` is spoofable (user could transfer wrong amount) — flag as known ceiling.
- Two "VietQR" products easily confused: vietqr.io (QR image APIs, Casso-linked webhooks) vs api.vietqr.vn (Pro, Get Token + Transaction Sync). Not interchangeable.
- Webhook callbacks need public HTTPS (tunneling in dev; ngrok documented by payOS examples).
- Exact VNPay param canonicalization and MoMo per-endpoint signature field lists need re-verification at integration time.
- No official English docs fully verified for VNPay IPN response format; uncertainty noted.

## Suggested next steps

1. Define `MockPaymentProvider` interface + event schema matching payOS webhook payload (1 file, ~1h).
2. Draft payment-events → ledger-billing event contract (idempotency key decision) (1–2h).
3. When ready for stage 2: register payOS sandbox merchant, wire webhook confirm + verify (~half day).

## Sources

- Kept: payOS webhook docs (https://payos.vn/docs/du-lieu-tra-ve/webhook/), payOS API (https://payos.vn/docs/api/) — primary vendor.
- Kept: vietqr.io Quick Link + generate API (https://www.vietqr.io/en/danh-sach-api/link-tao-ma-nhanh/) — primary vendor.
- Kept: api.vietqr.vn workflow/transaction-sync (https://api.vietqr.vn/en/vn/overview/description-of-vietqr-api-workflow) — confirmation mechanics.
- Kept: MoMo digital signature (https://developers.momo.vn/v3/docs/payment/api/other/signature/) — primary vendor.
- Kept: VNPay sandbox docs (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html) — primary vendor.
- Deprioritized: deepwiki/apis.io/community SDK mirrors — used only as corroboration; verify against vendor originals.
