/* NEAR vault contract: moves NEAR or one NEP-141 transfer only after an on-chain ML-DSA-87 check.
 * One vault per account, created by contract/factory.c in one fixed batch (create, fund, deploy, init).
 * A vault created any other way is not trusted: see SECURITY.md. Message layout: docs/PROTOCOL.md. */
#include <stdint.h>
#include <stddef.h>
#include "../core/pq87.h"
#include "../core/memory.h"
#ifdef QP_BENCH
#error "the vault is never built with the profiling opcodes"
#endif
#ifndef QP_CHAIN
#error "build with -DQP_CHAIN='\"testnet\"' (or mainnet, sandbox): the network this binary serves"
#endif

#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))
IMPORT(input) void input(uint64_t reg);
IMPORT(register_len) uint64_t register_len(uint64_t reg);
IMPORT(read_register) void read_register(uint64_t reg, uint64_t ptr);
IMPORT(value_return) void value_return(uint64_t len, uint64_t ptr);
IMPORT(log_utf8) void log_utf8(uint64_t len, uint64_t ptr);
IMPORT(panic_utf8) void panic_utf8(uint64_t len, uint64_t ptr);
IMPORT(storage_read) uint64_t storage_read(uint64_t klen, uint64_t kptr, uint64_t reg);
IMPORT(storage_write) uint64_t storage_write(uint64_t klen, uint64_t kptr, uint64_t vlen, uint64_t vptr, uint64_t reg);
IMPORT(current_account_id) void current_account_id(uint64_t reg);
IMPORT(predecessor_account_id) void predecessor_account_id(uint64_t reg);
IMPORT(block_index) uint64_t block_index(void);
IMPORT(account_balance) void account_balance(uint64_t ptr);
IMPORT(storage_usage) uint64_t storage_usage(void);
IMPORT(sha256) void sha256(uint64_t len, uint64_t ptr, uint64_t reg);
IMPORT(promise_batch_create) uint64_t promise_batch_create(uint64_t len, uint64_t ptr);
IMPORT(promise_batch_action_transfer) void promise_batch_action_transfer(uint64_t idx, uint64_t amount_ptr);
IMPORT(promise_batch_action_function_call) void promise_batch_action_function_call(
  uint64_t idx, uint64_t mlen, uint64_t mptr, uint64_t alen, uint64_t aptr, uint64_t amount_ptr, uint64_t gas);

#define CONTEXT "qlyphs/near-vault/v1"
#define MAGIC "QLYP87N1"
#define MSG 256u
#define MAX_ID 64u
#define MAX_TTL_BLOCKS 1800u
#define TGAS 1000000000000ULL
#define FT_GAS_MIN 10u                        /* signed ft_transfer gas bounds, in Tgas */
#define FT_GAS_MAX 100u
#define BYTE_COST 10000000000000000000ULL     /* 10^19 yoctoNEAR per stored byte (protocol storage price) */

/* Message offsets (little-endian, ids are zero-padded ASCII). */
enum { M_MAGIC = 0, M_CHAIN = 8, M_VLEN = 16, M_VAULT = 17, M_KIND = 81, M_TLEN = 82, M_TOKEN = 83,
       M_RLEN = 147, M_RECV = 148, M_AMOUNT = 212, M_NONCE = 228, M_EXPIRY = 236, M_ISSUED = 244, M_FTGAS = 252, M_ZERO = 253 };

static uint8_t buf[PQ87_SIG + MSG];
static uint8_t pk[PQ87_PK];
static uint8_t self_id[MAX_ID + 1];
static size_t self_len;

static void fail(const char *m) { size_t n = 0; while (m[n]) n++; panic_utf8(n, (uint64_t)(uintptr_t)m); }
#define REQUIRE(c, m) do { if (!(c)) fail(m); } while (0)
#define PTR(p) ((uint64_t)(uintptr_t)(p))

static uint64_t le64(const uint8_t *p) { uint64_t x = 0; for (unsigned i = 0; i < 8; i++) x |= (uint64_t)p[i] << (8 * i); return x; }
static void put64(uint8_t *p, uint64_t x) { for (unsigned i = 0; i < 8; i++) p[i] = (uint8_t)(x >> (8 * i)); }
static int zero(const uint8_t *p, size_t n) { unsigned x = 0; for (size_t i = 0; i < n; i++) x |= p[i]; return x == 0; }

static size_t read_reg(uint64_t reg, uint8_t *out, size_t cap) {
  uint64_t n = register_len(reg);
  REQUIRE(n != UINT64_MAX && n <= cap, "register too large");
  read_register(reg, PTR(out));
  return (size_t)n;
}

static void load_self(void) { current_account_id(0); self_len = read_reg(0, self_id, MAX_ID); }

/* NEAR account id rules: 2..64 chars of [a-z0-9_.-], separators never leading, trailing or adjacent.
 * Checking this also keeps the ids safe to place in the JSON arguments of ft_transfer. */
static int valid_id(const uint8_t *s, size_t n) {
  if (n < 2 || n > MAX_ID) return 0;
  int sep = 1;
  for (size_t i = 0; i < n; i++) {
    uint8_t c = s[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sep = 0;
    else if (c == '-' || c == '_' || c == '.') { if (sep) return 0; sep = 1; }
    else return 0;
  }
  return !sep;
}

/* A zero-padded id field: valid id of the stated length, canonical (zero) padding. */
static int id_field(const uint8_t *m, unsigned len_at, unsigned at) {
  unsigned n = m[len_at];
  return n <= MAX_ID && valid_id(m + at, n) && zero(m + at + n, MAX_ID - n);
}

/* 128-bit helpers on two 64-bit halves: no __int128, so no compiler-rt in a -nostdlib build. */
typedef struct { uint64_t lo, hi; } u128;
static u128 rd128(const uint8_t *p) { u128 x = { le64(p), le64(p + 8) }; return x; }
static int lt128(u128 a, u128 b) { return a.hi < b.hi || (a.hi == b.hi && a.lo < b.lo); }
static u128 sub128(u128 a, u128 b) { u128 r = { a.lo - b.lo, a.hi - b.hi - (a.lo < b.lo) }; return r; }
static u128 mul64(uint64_t a, uint64_t b) {
  uint64_t a0 = (uint32_t)a, a1 = a >> 32, b0 = (uint32_t)b, b1 = b >> 32;
  uint64_t p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  uint64_t mid = (p00 >> 32) + (uint32_t)p01 + (uint32_t)p10;
  u128 r = { (mid << 32) | (uint32_t)p00, p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32) };
  return r;
}
/* Decimal digits of a 128-bit value, most significant first; returns the length. */
static size_t dec128(u128 x, char out[40]) {
  uint32_t limb[4] = { (uint32_t)(x.hi >> 32), (uint32_t)x.hi, (uint32_t)(x.lo >> 32), (uint32_t)x.lo };
  char rev[40]; size_t n = 0;
  do {
    uint64_t rem = 0; int nonzero = 0;
    for (unsigned i = 0; i < 4; i++) { uint64_t cur = (rem << 32) | limb[i]; limb[i] = (uint32_t)(cur / 10); rem = cur % 10; nonzero |= limb[i] != 0; }
    rev[n++] = (char)('0' + rem);
    if (!nonzero) break;
  } while (1);
  for (size_t i = 0; i < n; i++) out[i] = rev[n - 1 - i];
  return n;
}

static uint64_t stored_nonce(void) {
  uint8_t n[8];
  REQUIRE(storage_read(1, PTR("n"), 0) == 1 && read_reg(0, n, 8) == 8, "vault not initialized");
  return le64(n);
}

/* init(pk): called by the factory inside the creating batch. The predecessor must be the direct
 * parent account (one label above), and a vault is initialized once. Input: the raw 2,592-byte key. */
EXPORT(init) void init(void) {
  input(0);
  REQUIRE(read_reg(0, pk, PQ87_PK) == PQ87_PK, "expected a 2592-byte ML-DSA-87 public key");
  REQUIRE(storage_read(1, PTR("n"), 0) == 0, "already initialized");
  load_self();
  uint8_t parent[MAX_ID + 1];
  predecessor_account_id(0);
  size_t plen = read_reg(0, parent, MAX_ID);
  REQUIRE(self_len > plen + 1 && self_id[self_len - plen - 1] == '.' && memcmp(self_id + self_len - plen, parent, plen) == 0,
          "init must come from the parent account");
  for (size_t i = 0; i < self_len - plen - 1; i++) REQUIRE(self_id[i] != '.', "init must come from the parent account");
  uint8_t n[8] = { 0 };
  storage_write(1, PTR("k"), PQ87_PK, PTR(pk), 0);
  storage_write(1, PTR("n"), 8, PTR(n), 0);
}

/* execute(sig | msg): verifies the signature under the stored key, consumes the nonce, then pays.
 * Anyone may relay it; the relayer pays gas and can only delay or drop the payment. */
EXPORT(execute) void execute(void) {
  input(0);
  REQUIRE(read_reg(0, buf, sizeof(buf)) == sizeof(buf), "expected signature (4627) and message (256)");
  const uint8_t *sig = buf, *m = buf + PQ87_SIG;
  uint64_t nonce = stored_nonce();
  REQUIRE(storage_read(1, PTR("k"), 0) == 1 && read_reg(0, pk, PQ87_PK) == PQ87_PK, "missing key");
  load_self();

  static const char chain[8] = QP_CHAIN;
  REQUIRE(memcmp(m + M_MAGIC, MAGIC, 8) == 0, "bad magic");
  REQUIRE(memcmp(m + M_CHAIN, chain, 8) == 0, "wrong network");
  REQUIRE(m[M_VLEN] == self_len && memcmp(m + M_VAULT, self_id, self_len) == 0 && zero(m + M_VAULT + self_len, MAX_ID - self_len),
          "message is for another vault");
  REQUIRE(m[M_KIND] <= 1, "unknown action");
  if (m[M_KIND] == 0) REQUIRE(m[M_TLEN] == 0 && zero(m + M_TOKEN, MAX_ID) && m[M_FTGAS] == 0, "token set on a NEAR transfer");
  else REQUIRE(id_field(m, M_TLEN, M_TOKEN) && m[M_FTGAS] >= FT_GAS_MIN && m[M_FTGAS] <= FT_GAS_MAX, "bad token account or gas");
  REQUIRE(id_field(m, M_RLEN, M_RECV), "bad receiver account");
  REQUIRE(!(m[M_RLEN] == self_len && memcmp(m + M_RECV, self_id, self_len) == 0), "receiver is the vault");
  REQUIRE(zero(m + M_ZERO, MSG - M_ZERO), "reserved bytes must be zero");
  u128 amount = rd128(m + M_AMOUNT);
  REQUIRE(amount.lo | amount.hi, "amount must be positive");
  REQUIRE(le64(m + M_NONCE) == nonce && nonce != UINT64_MAX, "stale or reused nonce");
  uint64_t now = block_index(), issued = le64(m + M_ISSUED), expiry = le64(m + M_EXPIRY);
  REQUIRE(issued <= now && now < expiry && expiry - issued <= MAX_TTL_BLOCKS, "authorization expired or not yet valid");

  REQUIRE(pq87_verify(pk, PQ87_PK, sig, PQ87_SIG, m, MSG, (const uint8_t *)CONTEXT, sizeof(CONTEXT) - 1) == 0, "invalid signature");

  /* Keep the storage stake: the runtime would refuse the call anyway, this gives a clear error. */
  uint8_t bal[16]; account_balance(PTR(bal));
  u128 balance = rd128(bal), locked = mul64(storage_usage(), BYTE_COST), one = { 1, 0 };
  REQUIRE(!lt128(balance, locked) && !lt128(sub128(balance, locked), m[M_KIND] == 0 ? amount : one), "insufficient balance");

  /* Spend the nonce before the payment receipt exists. If delivery fails later (unknown receiver,
   * receiver not registered on the token) the funds come back to or stay in the vault; the
   * authorization stays spent and the owner signs a new one. */
  uint8_t next[8]; put64(next, nonce + 1);
  storage_write(1, PTR("n"), 8, PTR(next), 0);

  if (m[M_KIND] == 0) {
    uint64_t p = promise_batch_create(m[M_RLEN], PTR(m + M_RECV));
    promise_batch_action_transfer(p, PTR(m + M_AMOUNT));
  } else {
    char args[40 + MAX_ID + 40]; size_t n = 0; char digits[40]; size_t d = dec128(amount, digits);
    static const char a[] = "{\"receiver_id\":\"", b[] = "\",\"amount\":\"", c[] = "\"}";
    memcpy(args + n, a, sizeof(a) - 1); n += sizeof(a) - 1;
    memcpy(args + n, m + M_RECV, m[M_RLEN]); n += m[M_RLEN];
    memcpy(args + n, b, sizeof(b) - 1); n += sizeof(b) - 1;
    memcpy(args + n, digits, d); n += d;
    memcpy(args + n, c, sizeof(c) - 1); n += sizeof(c) - 1;
    uint8_t yocto[16] = { 1 };
    uint64_t p = promise_batch_create(m[M_TLEN], PTR(m + M_TOKEN));
    promise_batch_action_function_call(p, 11, PTR("ft_transfer"), n, PTR(args), PTR(yocto), m[M_FTGAS] * TGAS);
  }
  char line[64] = "executed nonce "; size_t ln = 15; char nd[40];
  size_t d = dec128((u128){ nonce, 0 }, nd); memcpy(line + ln, nd, d); ln += d;
  log_utf8(ln, PTR(line));
}

/* View: {"chain":..,"nonce":N,"pk_sha256":"<hex>"} so a wallet can check the vault before signing. */
EXPORT(state) void state(void) {
  uint64_t nonce = stored_nonce();
  REQUIRE(storage_read(1, PTR("k"), 0) == 1 && read_reg(0, pk, PQ87_PK) == PQ87_PK, "missing key");
  uint8_t h[32]; sha256(PQ87_PK, PTR(pk), 1); REQUIRE(read_reg(1, h, 32) == 32, "sha256");
  static const char hexd[] = "0123456789abcdef", chain[] = QP_CHAIN;
  char out[256]; size_t n = 0; char nd[40]; size_t d = dec128((u128){ nonce, 0 }, nd);
#define PUT(s) do { const char *s_ = (s); while (*s_) out[n++] = *s_++; } while (0)
  PUT("{\"version\":\"" CONTEXT "\",\"chain\":\""); PUT(chain); PUT("\",\"nonce\":");
  memcpy(out + n, nd, d); n += d;
  PUT(",\"pk_sha256\":\"");
  for (unsigned i = 0; i < 32; i++) { out[n++] = hexd[h[i] >> 4]; out[n++] = hexd[h[i] & 15]; }
  PUT("\"}");
#undef PUT
  value_return(n, PTR(out));
}
