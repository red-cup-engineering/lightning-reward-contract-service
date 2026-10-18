# Lightning Reward Contract Service — YABCM regtest receiving candidate

**Source owner:** Red Cup Engineering → Financial Engineering. **Consumer:** Causeway Public Agent Services / Yet Another Bitcoin Cloud Miner (YABCM). **Other upstream suppliers:** Red Cup Capability Pricing `./fixed-term-reward-ceiling` and `./prefunded-lightning-inventory`. **Production status:** runnable **regtest-only** source and isolated fixture integration; **NOT mainnet, live sales, real advertiser callback, x402 checkout, or customer-facing payouts**.

## Actual problem this solves

The first YABCM application only animates local points. The pre-funded Lightning calculator could quote a possible purchase but did not **atomically prevent two clients from purchasing the same financial reserve**. It also modeled withdrawals per contract, which would make fractional-sat amounts accumulated through many free/ad plans effectively unwithdrawable. This service fills those two concrete gaps:

- One **dedicated Lightning payout node and one persistent owner** for all obligations against it; SQLite WAL and `BEGIN IMMEDIATE` make reservation acceptance exclusive even across processes.
- Product/source-authored **finite** contracts with exact max-reward and max-fee budgets from existing Capability Pricing; daily limits, cooldown, overlap admission under the same transaction, not browser state.
- A durable reservation before any external payment admission; idempotent IDs with conflict detection and immutable termsRef/digest. A reservation never means a charge was accepted.
- Separate activation only after an independently received free grant/partner postback/payment result; server clock and immutable duration set accrual. A progress animation is never financial evidence.
- An account can **pool earned integer millisatoshis across many finite contracts**, retaining each order's provenance and payout/fee allocation. Withdrawal minimum applies to the customer's total eligible earned balance, not to each tiny contract.
- CLN BOLT11 regtest decode and `xpay` dispatch are isolated behind an authenticated wallet adapter; outstanding payouts remain booked through restart, ambiguous payment status and route failure. A second request cannot resend an in-flight invoice without first reconciling `listpays`.
- Real wallet snapshots are from an authorized CLN node, never a browser-provided balance. Only live `CHANNELD_NORMAL` / connected outbound spendable liquidity contributes to capacity, and the wallet's network is checked as **regtest** on every RPC request.

**Crucial boundaries:** `wallet-exclusive` must be real operational custody, not a JSON fiction. There must be no external spends from the same node outside this book and no other ledger claiming the same sats. Our test process proves serialization, NOT operational exclusivity or Bitcoin solvency. No account-balance, Lightning-key, provider callback, or paid order is trusted from a client request. A compiled funding quote does not count as receipt; a pending payout does not count as failed or complete.

## Exact state flow

`wallet-node observation → eligible catalog term → RESERVED (atomic full worst-case sat/msat cap) → independently received grant/payment → ACTIVE → SERVER ACCRUED → ACCOUNT POOLED CREDIT → PREPARED withdrawal → IN-FLIGHT (persist before RPC) → independently observed CLN COMPLETE/FAILED/UNKNOWN → reconciled paid amount and fee → contract closure only after all earnings paid and expiry`.

*Refusal paths:* unobserved/disconnected/wrong-chain/stale wallet, missing original pricing provider or terms, catalog term mutation without a new reference, repeat order ID with changed party/terms, per-principal daily limit/cooldown/concurrent contract, negative/unbounded exact money, no full-term backing, payout under actual minimum, exceeded fee cap, new payment for an already committed invoice, operator permission missing, unresolved status after crash, and unpaid accrual at expiry.

## Run the isolated tests

Use Node **22.16+** (the versioned `node:sqlite` API is experimental on Node 22; production should pin its runtime, retain WAL durability tests and plan its eventual stable replacement). No additional dependencies are needed for the tests because their independent fixture substitutes only the upstream pricing interfaces. They do not test the real node RPC, commercial advertiser, or package publication.

```sh
node --test test/*.test.mjs
```

The suite covers real concurrent HTTP requests; **12 separate operating-system Node processes competing for one funded slot**; 12 same-ID processes; restarts; no-funds refusal; terms immutability; missing payout receipts; account-level pooling across three finite plans; fraud/invalid invoice conditions; whole-term accrual; no funding on a pure demo; and the outbound CLN adapter with a fixture RPC. The node cannot send on mainnet.

## Run the actual local Core Lightning regtest adapter

Prerequisites: two or more **independently operated Core Lightning regtest nodes**, with real (valueless) regtest channel capacity. Consult the [Core Lightning developer guide](https://docs.corelightning.org/docs/developers-guide). The dedicated payout node must be **exclusively** controlled by the service for any credible backing demonstration. The inventory source must be installed from its owner; this package names `@red-cup-engineering/capability-pricing-service@0.1.4` but **an npm release and installed dependency closure have not been received**.

1. Make a protected operator-secret file (at least 32 random bytes, mode `0600`) on the **test** host. It must never appear in this repository or in the user's browser.
2. Select a source-authorized **regtest-only** plan catalog. `examples/regtest-catalog.json` is fictional, testnet-specific, and permits only a manually confirmed **free** grant.
3. Install the upstream pricing package and the pinned Node runtime on the host. Bring up a **regtest** CLN payout node and fund a channel with **valueless** test coins. Do not use a mainnet node.
4. Start from this source root:

```sh
npm run serve:regtest -- \
  --catalog ./examples/regtest-catalog.json \
  --db /private/secure/yabcm-regtest.sqlite \
  --wallet-id payout-regtest-node \
  --lightning-dir /private/cln/test-node \
  --secret-file /private/secure/operator-token \
  --safety-reserve-msat 1000000 \
  --external-reserve-msat 0 \
  --withdraw-minimum-msat 1000 \
  --host 127.0.0.1 --port 19878
```

The server binds **loopback only**. A `GET /health` provides no financial balance; `GET /v1/catalog` reports no money or account identifiers, just plan availability, terms revision and bounded maximum cost. All state-changing `/ops/` routes require the operator Bearer token. A public website or a customer must **never** be given that token. The money-carrying paths remain nonpublic, until a separately authorized user identity and real customer-service boundary are designed and independently received.

In this particular regtest CLI, activating an externally paid or sponsored plan is impossible: the only accepted fixture proof is `manual-local-regtest-free:<orderId>` for `regtest-free-contract`. No sponsor SDK, credit processor, recurring charge, or transfer authorization is secretly embedded.

## Concrete commands / receiving

- `POST /ops/wallet/refresh` (operator only) reads `getinfo` and live channel capacity from the original CLN RPC.
- `POST /ops/reserve` with `{orderId,principalId,planId}` accepts only an existing **fully covered** fixed-term plan; reserves atomically before external consideration.
- `POST /ops/activate` with `{orderId,proof}` invokes the independently selected grant verifier, not client-owned reward logic.
- `POST /ops/accrue` with `{orderId}` recomputes and records earned whole-msat from the server clock and selected plan edition.
- `POST /ops/account` with `{principalId}` reports private pooled earned, paid, in-flight and still-claimable integer msat to the operator only.
- `POST /ops/payout/prepare` with `{requestId,principalId,invoice,amountMsat,feeLimitMsat}` verifies a real regtest invoice using the CLN source before reserving the account's existing pooled earned credits and fee budget.
- `POST /ops/payout/dispatch` with `{requestId}` persists the **in-flight** status BEFORE invoking the authorized CLN `xpay` using an explicit fee maximum; a repeated request never attempts another send when in flight.
- `POST /ops/payout/reconcile` with `{requestId}` reads the original wallet's `listpays` and only then posts each component to the original source contract. Unknown stays held. Failed is independently witnessed before credits are made available again.
- `POST /ops/close` / `POST /ops/void` additionally require independently received completion/refund evidence; a timer or browser click is insufficient to discard existing claims.

All HTTP requests are small bounded JSON; the operator is responsible for confidential TLS termination/access control on a real host, admissible identities, and data retention. Do not expose loopback admin endpoints through a generic reverse proxy or put browser secrets in static Cloudflare assets.

## What is still genuinely missing

1. A running **original CLN regtest network** with a truly funded outbound channel and independent receipt of actual invoice payment. Tests so far use a protocol-faithful fixture, not installed bitcoind/lightningd.
2. Deployment into the actual admitted shared financial book/treasury, or independently accepted custody that this exclusive reservation subledger is canonical. A source-owned SQLite file is **not** financial-operations receiving and should not be represented as the enterprise's whole ledger.
3. Signed eligible advertising partner and third-party cashback/survey postbacks, fraud adjudication and reversible advertiser receivables. Google and Unity rewarded inventory cannot be used for direct Bitcoin rewards under their ordinary policies.
4. A customer-account authentication, age/region and privacy boundary; cancellation/refunds, compliance and consumer-purchase law for any **paid** Bitcoin-linked term.
5. Original x402/merchant production receiver for paid plan purchases. This service explicitly does not accept money or automatically create a buyer charge.
6. Cloudflare deployment and independent public HTTP receiving of the updated **YABCM static consumer**. Its unauthenticated demo timer does not access this server or issue any real entitlement.
7. Cohort acquisition economics and legitimate rewards provider rate from source evidence, not headline eCPM / synthetic screenshots.

**Done definition:** on actual regtest CLN, two customers racing for the final wallet-backed finite term produce exactly one durable entitlement; a small reward accumulates across multiple eligible intervals into one payable invoice, which survives restart and is independently reconciled as complete/failed; no customer is charged and no reward is advertised without the real provider/eligibility/legal and transaction chain being received.

## Installed-source regression and same-origin regtest receiving (October 18)

The product is no longer just a browser-local timer or a read-only reserve quote. This specific Engineering source now has transactional SQLite custody for a **valueless regtest financial lifecycle** and a route to mount the owning Causeway's *already compiled* free game beside its **public read-only** `/v1/catalog` endpoint.

**Defects found through execution and corrected in the source:**

1. A paid invoice reduced outstanding ledger liabilities, but a new purchase could still use the **pre-payment Lightning wallet snapshot**, falsely recovering headroom and overselling the node. The SQLite book now holds `configuration.required_observation_seq` as a durable monotonic freshness barrier. Dispatch and terminal payout results invalidate all earlier wallet observations; an unresolved outgoing payment stops new reservations; only a **new post-finality** wallet reading restores availability. Legacy database migration invalidates old observations. Regression: [liquidity-barrier tests](test/liquidity-barrier.test.mjs), including an original reproducible overbooking case, pending/failed results and old-book migration.
2. The Core Lightning CLI path previously mixed positional placeholders and RPC named parameters without selecting `lightning-cli -k`. Its actual subprocess now uses documented `--regtest -k`, `decode string=<invoice>`, `xpay invstring=<invoice> maxfee=<msat>`, and `listpays payment_hash=<hash>`. Regression: [real subprocess adapter tests](test/cln-cli-process.test.mjs).
3. Initial real CLI execution found a unit mismatch: a rate quoted in **msat per hour** was compared against an **entire finite-term** cap, then an early correction used milliseconds per hour while the duration field was in seconds. The authoritative bound is `ceil(actual_rate_msat_per_hour × duration_seconds / 3600)`, which must not exceed the full-term cap derived by the original pricing provider. The [short-term pricing regressions](test/short-term-pricing.test.mjs) demonstrate an admissible 60-second plan and refuse an overpromising plan.
4. We tested actual startup/transport, not only injected in-process functions: [installed CLI test](test/installed-regtest-cli.test.mjs) starts `scripts/serve-regtest.mjs` as an operating-system process, substitutes only the upstream pricing package and the valueless CLI provider, sends HTTP requests, admits an authorized free term, accrues server-side, prepares and dispatches a **mock** invoice, reconciles provider status, observes stale-wallet suspension, and requires a fresh wallet read.
5. [Static asset admission](src/regtest-site-assets.mjs) will **only** mount the exact source-built free demo's ten nonmonetary files. It rejects missing assets, escaping symlinks, oversized files and any `/api/status.json` claiming real rewards, custody, or x402. The operator HTTP host remains `127.0.0.1`; `GET /v1/catalog` remains anonymous and read-only, but `/ops/*` requires the operator secret. All content is CSP-confined to same-origin code and a same-origin catalog read.

### Assemble a real local preview from the **owning** sections

First, as the authorized builder, build the Causeway YABCM site from its `site.json` using the original [Red Cup Web Game Engineering publisher](https://github.com/red-cup-engineering/web-game-services-section/tree/main/services/virtual-miner-experience-service):

```sh
cd /path/to/web-game-services-section/services/virtual-miner-experience-service
npm test
node scripts/build.mjs \
 --config /path/to/public-services-section/services/public-agent-services-section/sites/yabcm.assist.561.group/site.json \
 --out /path/to/public-services-section/services/public-agent-services-section/sites/yabcm.assist.561.group/dist
```

Then use the normal operator-secret and regtest-node arguments in the earlier CLI command, **adding**:

```sh
--demo-dist /path/to/public-services-section/services/public-agent-services-section/sites/yabcm.assist.561.group/dist
```

The resulting single *local-only* listener can return `GET /` (real built YABCM HTML), `GET /assets/regtest-catalog-client.mjs`, `GET /api/status.json`, `GET /v1/catalog` (current laboratory plan-capacity quote), and authenticated `POST /ops/*`. The game shows a collapsed **Regtest developer laboratory** readout; if no backend is mounted, that readout fails closed and **the demo remains playable**. It never moves funds or offers a real purchase from the visitor's browser.

**Installation gates not met:** there is no actual Core Lightning or bitcoind regtest daemon in this ChatGPT working container, no independently installed/published upstream `@red-cup-engineering/capability-pricing-service@0.1.4` closure in the daemon run, no cloud routing, no authenticated customer identity or completed real invoice payment; the process integration uses controlled fake `lightning-cli` responses. No advertiser network is approved to pay sats. Do not treat a native test, static build or local demo HTTP response as an external payout.

**Receiving criteria:** run this same CLI and end-to-end sequence with two real CLN regtest nodes and valueless channels; confirm channel conditions, no double sends after restart, exact full-term reservation for changing plans, account pooling of msat over multiple finite contracts, real invoice preimage and fee receipts, underfunding and payout recovery. Independently receive the original Public website over its final chosen route before promoting it. Mainnet wallets, user payments, and crypto conversion remain disabled pending proper legal/financial/provider authority.

The [authoritative open Finance issue](https://github.com/red-cup-engineering/financial-engineering-services-section/issues/36) tracks the remaining actual CLN, contractual payment, operational custody and public receiving work rather than calling this laboratory service deployed.

## Automatic server-clock reward materialization (post-integration repair)

The source-level end-to-end review caught another genuine product defect: even when multiple contracts had elapsed, the original `GET /ops/account` projection and `POST /ops/payout/prepare` only read previously materialized `earned_msat`. Unless a separate operator process called `POST /ops/accrue` for *every* order, a person could wrongly appear unable to withdraw sufficiently earned rewards.

The original [SQLite subledger](src/reservation-store.mjs) now uses a **transaction-internal `materializeOrder` / `materializePrincipal`** path on account reads and pooled payout preparation. Server-clock elapsed rewards are recomputed *within the same exclusively locked SQLite booking transaction* as payout allocation. A browser clock, claim click or optimistic animation cannot create a financial event. A repeated read cannot double-credit the same interval; existing reserve caps still cover the entire original term and fees. Unactivated orders remain unpaid, and simultaneous payout allocations retain their protective claim locks.

[Three native regression tests](test/auto-accrual.test.mjs) demonstrate: reading an account after two elapsed hours emits exactly the corresponding 2,200msat without any explicit operator accrual; three 8-hour contracts can fund one 20,000msat pooled payout without separate accrual calls and prevent a second reuse; an unactivated reserved plan accrues zero even when time passes. The **full local native suite passes 48/48 tests** on Node 22.16 and SQLite (still marked experimental by that runtime).

This remains a **regtest-only working system**, with an explicit test-only CLN and upstream pricing adapter in the installed-process suite. Real two-node Core Lightning regtest receipts, actual original dependency installation, no-self-signup/free-grant abuse controls, real customer identities, and qualified ad partners are not yet received. **No mainnet payment, real-sats user promise, commercial launch or task schedule change is authorized.**
