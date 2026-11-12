# The `/bridge/quantum` page

This folder is the source of the page you use at
[app-testnet.qlyphs.com/bridge/quantum](https://app-testnet.qlyphs.com/bridge/quantum), copied from the Qlyphs
platform as it is deployed.

Qlyphs is a live product, and its platform is not open source. This folder publishes everything that belongs to
the route: every screen, every byte the page signs, encrypts or sends, and the tests. It leaves out only the shared
parts of the platform it plugs into (listed below). The copy does not build into a website on its own. It is here
so you can read and test what the hosted page does.

## What is here

| Path | What it does |
|---|---|
| `lib/pq-route/crypto.js` | Route cryptography: backup seed, ML-DSA-65 NEAR keys, ML-DSA-87 request signatures, ML-KEM-1024 + AES-256-GCM request encryption. Same bytes as [`sdk/route-crypto.mjs`](../sdk/route-crypto.mjs) (checked by `same-crypto.test.ts`). |
| `lib/pq-route/route.ts` | Route constants (contracts, Quantus genesis), NEAR reads, the route challenge the Qlyphs wallet signs, pay links, the calls to the route service. |
| `lib/pq-route/payment.ts`, `pay-steps.ts` | A transfer as a resumable state machine: lock on Quantus, sign the destination, claim, wait for the mint. Nothing is sent twice after a reload. |
| `lib/pq-route/chain.ts` | The way back: the NEAR account's own ML-DSA-65 key signs the withdrawal from NEAR Intents. |
| `lib/pq-route/withdrawals.ts` | Matches releases on Quantus to the withdrawals that caused them. |
| `lib/pq-route/requests.ts` | The requests this browser created (display only, nothing secret). |
| `lib/near-wallet.ts` | NEAR Wallet Selector. Here it is used only for Meteor Wallet. `nearDeleteKeys` refuses anything but ed25519 and secp256k1 keys, so it can never remove a post-quantum key. |
| `lib/address.ts`, `lib/ss58.ts` | Quantus addresses (SS58) to and from account ids. |
| `components/pq-route/` | The screens: Bridge, Request, Pay, the transfer and its steps, the animated route picture, Meteor. |

## What the page sends, and where

Search for `fetch(` and `sendTx(`. These are all the places the page sends something:

- **NEAR testnet RPC** (`rpc.testnet.fastnear.com`): reads (keys, balances, transactions) and, on the way back,
  the withdrawal signed in the browser by the account's ML-DSA-65 key.
- **Quantus test chain RPC** (`testnet-rpc.qlyphs.com`): reads.
- **Route service** (`qlyphs-pq-route.qlyphs.workers.dev`, source in [`route-worker/`](../route-worker)):
  - `POST /accounts` receives a **public** ML-DSA-65 key and creates the NEAR account;
  - `POST /requests` receives the **encrypted** request;
  - `POST /claims` receives the claim the Qlyphs wallet signed;
  - `GET /requests/:id` and `GET /mints/:id` read back.
- **Qlyphs wallet** (browser extension): signs the Quantus transfer and the route challenge with ML-DSA-87.
  The page never sees that key.

No secret key and no plaintext request leaves the browser.

The backup seed, from which every NEAR key of this browser is derived, is kept in this browser's `localStorage`
and is not encrypted there. The page shows it under *Backup of this browser*. It is a test-network design: anyone
with access to the browser profile can read it.

## Not included

These are imported from the platform but not published. None of them signs, encrypts or sends anything for the route:

- `@qotc/ui`: buttons, inputs, `cn`.
- Small shared components: `check-draw`, `copy-feedback`, `intents-parts` (token logos), `network-mark`, `step-bar`.
- `lib/intents`, `lib/intents-logos`, `lib/bridge`: the QTC asset id and logos.
- `lib/intents-chains`: `quantusAccountId`, the SS58 check of a pasted Quantus address.
- `lib/qlyphs`, `lib/reads`: the connection to the Qlyphs wallet extension and the read of its spendable balance.

## Run the tests

From the repository root, with Node 23.6 or later (it runs TypeScript directly):

```bash
npm ci
node --test app/lib/pq-route/*.test.ts
```

The tests cover:
- pay links;
- the resumable transfer state machine;
- withdrawal matching;
- the Meteor key checks;
- the identity of the page's crypto with `sdk/route-crypto.mjs`.

They are offline.
