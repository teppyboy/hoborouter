# USD Bundle and Subscription Pricing

## Goal

Make credit bundles and subscription plans USD-priced at checkout, while keeping wallet balances, ledger entries, and settlement amounts as integer VND. Members see USD by default and can toggle display to VND. Existing subscription cancellation and separate billing sections remain unchanged.

## Design

### Catalog

Add exact decimal-text USD price fields to credit bundles and subscription plans. Admin writes values such as `5` or `9.99`; the API validates at most two decimal places and positive amounts. Existing VND fields remain during migration as settlement fallback and for existing records.

Bundle and subscription credit values remain integer VND because wallet credit is VND. New records authored in USD derive their VND credit once using the canonical payment FX rate and snapshot that result; historical records are never recomputed.

### FX and checkout

Use the payment settings FX rate as the only canonical rate. The server parses USD text into cents, converts cents to VND with ceiling rounding, and snapshots the input currency, input amount text, and FX rate when creating payment/reservation data. The browser sends an item ID and selected display currency only; it never submits an authoritative converted charge.

PayOS continues receiving integer VND. Existing idempotent payment settlement and wallet reservation paths remain unchanged.

### UI

`/billing/bundles` keeps separate Credit bundles and Subscription plans sections. USD is the default display when the canonical FX rate exists; a toggle displays exact VND conversion. Purchase actions use the item ID and server-side pricing. Active subscriptions retain the existing Cancel subscription action: cancellation stops renewal, preserves credit through `period_end`, and makes no refund or ledger mutation.

### Compatibility

Existing VND-authored catalog rows continue to purchase using their stored VND price. New USD-authored rows use the snapshotted USD price and conversion. No ledger migration or balance migration is required.

### Testing

- Validate USD decimal text, positive bounds, and two-decimal maximum.
- Verify exact cents-to-VND ceiling conversion.
- Verify bundle and subscription payment creation snapshots input currency, amount text, and FX rate.
- Verify server ignores client-supplied authoritative amounts.
- Verify cap enforcement and idempotent settlement/no double credit.
- Verify USD/VND display toggle and separate sections.
- Verify active subscription cancellation behavior remains intact.

## Open implementation choice

The migration should choose either nullable USD catalog columns plus derived VND values, or USD-only authoring with a generated/recorded VND settlement value. The implementation plan must select the smaller additive migration after inspecting current admin and payment contracts.
