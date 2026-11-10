# The post-quantum QTC route: Quantus ↔ NEAR, through NEAR Intents

Status: testnet prototype (Quantus development network, NEAR testnet). Not audited. No real funds.

## The gap

QTC is signed with ML-DSA on Quantus, and a NEAR account can hold an ML-DSA-65 key since protocol 88.
Between the two, authorization is still classical: on NEAR mainnet every QTC minted through the existing
route is authorized by the bridge operator account `bridge-mng.near`, whose only access key is one ed25519
key (snapshot: `evidence/bridge-mng-snapshot.json`). NEAR's own roadmap lists threshold ML-DSA signing as
research and post-quantum verification of foreign chains for 2027.

This route shows, for a chain with a native ML-DSA multisig, that every authorization on the path can be
post-quantum today, without new cryptography:

| Step | Who authorizes | Scheme |
|---|---|---|
| Lock QTC on Quantus | the depositor | ML-DSA-87 (Quantus transaction) |
| Choose where it goes on NEAR | the same key, signing the route | ML-DSA-87 |
| Mint on NEAR | 2 of 3 attesters, verified on-chain by the bridge contract | ML-DSA-87 |
| Hold and move inside NEAR Intents | the holder's NEAR account | ML-DSA-65 (native key) |
| Withdraw to Quantus | the holder's NEAR account, `ft_withdraw` with `WITHDRAW_TO:` | ML-DSA-65 (native key) |
| Release from the lock | 2 of 3 attesters, enforced by the native Quantus multisig | ML-DSA-87 |
| Pay gas for the mint | the relayer, which has no authority | ML-DSA-65 (its only key) |

Payment requests are encrypted with ML-KEM-1024 + AES-256-GCM; receipts with AES-256-GCM under a key derived from the recipient's backup.

**Trust, stated plainly.** The demo uses three separate ML-DSA-87 attester keys, all operated by the Qlyphs team in one service.
It demonstrates 2-of-3 authorization, not independent operators or decentralized custody. The attesters
check Quantus deposits themselves; NEAR does not verify Quantus consensus. Two compromised attesters could
mint unbacked tokens or release the reserve. NEAR validator signatures and consensus remain ed25519.

## Contracts on NEAR testnet (`deployments/route-testnet.json`)

- `intents.qlyphs-pqroute-b.testnet`: the NEAR Intents verifier, built from github.com/near/intents at
  `32cd1f97`, unmodified, initialized with no roles. There is no official Intents deployment on testnet.
- `qtc.qlyphs-pqroute-a.testnet`: the bridge token, `contract/bridge.c`. Created, deployed and initialized in
  one batch by its parent: it has never had an access key, so nobody can upgrade it or change its attesters.
- `relay.qlyphs-pqroute-a.testnet`: pays gas for mints; its only key is ML-DSA-65.

## Formats

**Route** (240 bytes): `"QLYPRTE2"` | deposit id (32) | bridge id (length u8 + 64) | receiver id (length u8 +
64) | mode u8 (1 = into Intents) | SHA-256(receipt) (32) | SHA-256(the receiver's ML-DSA-65 key handle, ASCII)
(32) | zeros. The route commits to the handle NEAR lists the key under (`ml-dsa-65-hash:…`, SHA3-256 of the key),
never to the full key, so a claim may name the receiver's key either in full or by that handle: an account opened in
another wallet (Meteor) is known on NEAR only by the handle. The depositor authorizes it with the key that signed the Quantus transfer: either an ML-DSA-87
signature over it (context `qlyphs/near-route/v1`, command line), or, from the Qlyphs wallet, a site session
challenge whose nonce is SHA-256 of these bytes, whose service is the lock and whose account is the depositor.

**Receiver readiness**, read at one finalized block (all conditions hold together), checked by the payer before
locking and by every attester before signing: the receiver
exists; its only access key is a FullAccess key whose handle is exactly the route's; it has no contract, local or
global; NEAR Intents holds no signing key for it (`public_keys_of` is empty) and authenticates it by its own
account (`is_auth_by_predecessor_id_enabled`). So nobody, the sponsor included, can hold the account before the
tokens arrive. The same rule admits an account the person already holds, such as one in Meteor Wallet, once its only
key is one full-access ML-DSA-65 key: an account that still has a classical key is refused before any QTC moves.

**Attestation** (288 bytes, signed by two attesters, context `qlyphs/near-bridge/v1`):

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | `QLYPBRG1` |
| 8 | 8 | NEAR network tag, zero padded |
| 16 | 65 | bridge account id (length + 64, zero padded) |
| 81 | 32 | Quantus genesis hash |
| 113 | 32 | deposit id = SHA-256(Quantus block hash ‖ extrinsic index u32 LE) |
| 145 | 16 | amount in planck, u128 LE (QTC keeps its 12 decimals: 1 planck = 1 unit) |
| 161 | 65 | receiver account id |
| 226 | 32 | SHA-256 of the encrypted receipt, or zero |
| 258 | 1 | mode: 0 credit the receiver, 1 deposit into the configured Intents verifier for it |
| 259 | 29 | zero |

**Mint input**: attestation | index | signature (4,627) | index | signature | receipt length u16 | receipt.
The contract checks every field, two different attesters, both signatures, and that the deposit id was never
minted; it records the deposit id before crediting.

**Withdrawal**: the holder calls the verifier's `ft_withdraw({token, receiver_id: token, amount,
memo: "WITHDRAW_TO:<64 hex Quantus account id>"})`. The verifier calls the bridge's `ft_transfer` to itself,
which burns and records `{amount, quantus_to, block, account}` under a sequential redemption id. The attesters
read redemptions at the final block and release each one once, journaled per redemption id: a restart
replays the journal and never pays twice. A release is one operation for the whole committee: attester 1
proposes and attester 2 approves, and a release begun by one proposer is never begun again by another, so a change
of signers cannot create a second proposal. Liquidity is checked only before a new transfer. Crash drills on the
live test chain (SIGKILL after the proposal, and after the approval, reached the chain) each paid exactly once
(`evidence/route-crash-drills.json`). The attesters sign a deposit at 8 confirmations under the demo policy, which
is not Quantus's default finality (100 blocks).

What the release journal records, precisely: `sent` means the extrinsic was durably prepared and possibly
broadcast (it is written before the RPC call); `done` means it was found included on the canonical chain with a
successful outcome. A release is recorded at inclusion, not at finality. After a crash, a `sent` step is concluded
`done` if the extrinsic is found, and `aborted` only with proof of absence: every canonical block of its mortal era
read, the era ended at least 20 blocks below the head, and the range unchanged while reading. Otherwise it stays
`sent` and blocks that release until the chain can answer. Intent-only records and expired proposals also fail
closed and wait for a person (`npm run near:release -- --resume <id>`, same proposer, same journal key).

On the payer's side, a payment saves its complete authenticated terms (the request as verified, the pinned
recipient card, the deployment it names) before the wallet is asked for anything, and is saved per request and payer
as it advances (sending, sent with its transaction
hash, located, route signed, claim submitted, settled). A retry or a page reload resumes the same transfer; a new
transfer is sent only when the wallet said nothing was submitted, or when the person confirms it, or pastes the hash
to continue. A payment already under way finishes from those saved terms even after the request expired or its
service went away. "Inside NEAR Intents" is shown only when the mint transaction, read from NEAR by the page,
shows the verifier's ft_on_transfer returning 0 unused and the bridge keeping the whole amount; a refusal shows the
QTC on the recipient's account instead; anything else is reported as pending. The page accepts a mint only if it
is the transaction the route Worker's pointer names, a `mint` on the saved bridge whose attestation names this
payment's deposit, recipient, amount, network, genesis, mode and receipt, and reads delivery from that mint's own
child receipts.

Operator task: if a mint's NEAR response is lost before the service saved its hash, the deposit shows consumed and
the payer's page stays "checking where the QTC was delivered" (nothing is reminted; the recipient's restore still
finds the funds). `npm run near:backfill-mint -- <deposit id>` (service stopped) finds the relayer's successful mint
of that deposit to that recipient, publishes its pointer and records it. Not yet exercised on a live lost response. Withdrawals under 0.01 QTC are refused by the token itself before
anything changes (direct redeem and WITHDRAW_TO alike; through Intents the verifier keeps the balance); a release that keeps failing is set aside
after five attempts with its error, for a person to look at.

## Payment requests (sdk/route-crypto.mjs)

One 32-byte backup seed per wallet derives, with KMAC256 and separate labels: an ML-KEM-1024 key pair, an
ML-DSA-87 identity, a spend root and a scan root.

1. The recipient makes a request for one payer: a random 32-byte rid gives a fresh ML-DSA-65 key
   (KMAC256(spend root, network, rid)) and its account name `r<20 hex of SHA-256(key)>.<sponsor>`, and a
   receipt key (KMAC256(scan root, network, rid)). The sponsor (whose only key is ML-DSA-65) creates that
   account with exactly that key **before** the request is shared. The request (account, its public key, amount,
   memo, expiry, the encrypted receipt) is signed with the identity key and sealed to the payer's ML-KEM-1024 key
   (AES-256-GCM under KMAC256 of the shared secret).
2. The payer opens it against the recipient's whole card, obtained separately and pinned (never taken from the
   request), checks network, sponsor, amount, expiry and that the account name derives from its key, checks the
   receiver is ready (above), locks QTC and authorizes the route.
3. The receipt is published by the mint: rid | nonce | AES-256-GCM(receipt key, padded body), 284 bytes for
   everyone: fixed-size receipts contain no plaintext permanent recipient identifier (timing, copying and
transaction metadata stay observable).
4. Restore: from the seed alone the wallet reads every public receipt, derives only each candidate's receipt key
   from its rid, keeps the ones that open for its network, once per rid, whose account derives again from the
   seed. A receipt says a request was made, not that it was paid: balances come from the chain, inside Intents or
   on the account itself when the verifier refused the deposit.

The payer learns the account and its public key, never the spending key: it is derived from the recipient's
seed, not from anything the payer sees.

**What stays visible**: amounts, times, the Quantus depositor, the NEAR account and every transfer are public
on both chains. The payer knows who it paid. What the route keeps private is the request itself and the link
between the recipient's identity and each fresh account. It is not anonymity.
