/* Qlyphs Guardian: holds the admin powers (mint, upgrade) of one NEAR contract and uses them only after two of
 * three fixed ML-DSA-87 signers approve the exact operation and an on-chain delay has passed. Immutable: no
 * owner, no keys, no upgrade, no signer rotation, no arbitrary call. Protocol: docs/GUARDIAN.md. */
#include <stdint.h>
#include <stddef.h>
#include "../core/pq87.h"
#include "../core/memory.h"
#ifdef QP_BENCH
#error "the Guardian is never built with the profiling opcodes"
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
IMPORT(storage_remove) uint64_t storage_remove(uint64_t klen, uint64_t kptr, uint64_t reg);
IMPORT(current_account_id) void current_account_id(uint64_t reg);
IMPORT(predecessor_account_id) void predecessor_account_id(uint64_t reg);
IMPORT(block_timestamp) uint64_t block_timestamp(void);
IMPORT(sha256) void sha256(uint64_t len, uint64_t ptr, uint64_t reg);
IMPORT(promise_create) uint64_t promise_create(uint64_t alen, uint64_t aptr, uint64_t mlen, uint64_t mptr,
  uint64_t arglen, uint64_t argptr, uint64_t amount_ptr, uint64_t gas);
IMPORT(promise_then) uint64_t promise_then(uint64_t idx, uint64_t alen, uint64_t aptr, uint64_t mlen, uint64_t mptr,
  uint64_t arglen, uint64_t argptr, uint64_t amount_ptr, uint64_t gas);
IMPORT(promise_results_count) uint64_t promise_results_count(void);
IMPORT(promise_result) uint64_t promise_result(uint64_t idx, uint64_t reg);

#define CONTEXT "qlyphs/near-guardian/v1"
#define MAGIC "QLYPGRD1"
#define MAX_ID 64u
#define OP 320u
#define APPROVAL (1u + PQ87_SIG)
#define ENVELOPE (OP + 2u * APPROVAL)                  /* 9,576 */
#define CONFIG (1u + MAX_ID + 8u + 8u + 3u * PQ87_PK)  /* 7,857 */
#define MAX_CODE 131072u
#define NS 1000000000ULL
#define MIN_DELAY 60ULL
#define MAX_SPAN (30ULL * 24 * 3600)
#define MIN_WINDOW 3600ULL
#define TGAS 1000000000000ULL
#define TARGET_MINT_GAS (20 * TGAS)
#define TARGET_UPGRADE_GAS (150 * TGAS)
#define CALLBACK_GAS (10 * TGAS)

/* Operation offsets (docs/GUARDIAN.md). */
enum { O_MAGIC = 0, O_CHAIN = 8, O_GUARDIAN = 16, O_TARGET = 81, O_CONFIG = 146, O_NONCE = 178, O_ACTION = 186,
       O_DEADLINE = 187, O_PAYLOAD = 195, O_AMOUNT = 260, O_CODELEN = 227, O_FROM = 231, O_TO = 235 };
enum { MINT = 1, UPGRADE = 2, CANCEL = 3 };
/* Config offsets. */
enum { C_TARGET = 0, C_DELAY = 65, C_WINDOW = 73, C_KEYS = 81 };
/* Active record "a": status | bitmap | queued_at | eta | expires | operation. */
enum { A_STATUS = 0, A_BITMAP = 1, A_QUEUED = 2, A_ETA = 10, A_EXPIRES = 18, A_OP = 26, A_LEN = 26 + OP };
/* Terminal record "t": nonce | proposal hash | status. */
enum { T_LEN = 8 + 32 + 1 };
#define QUEUED 'Q'
#define EXECUTING 'X'

/* Storage keys: "C" config, "H" config hash, "N" next nonce, "a" active operation, "c" queued code,
 * "t" last terminal record. "C" is written once by init and is the initialization sentinel. */
static uint8_t in[ENVELOPE + MAX_CODE];
static uint8_t cfg[CONFIG], chash[32], act[A_LEN], self_id[MAX_ID], caller[MAX_ID];
static size_t self_len, caller_len;

static void fail(const char *m) { size_t n = 0; while (m[n]) n++; panic_utf8(n, (uint64_t)(uintptr_t)m); }
#define REQUIRE(c, m) do { if (!(c)) fail(m); } while (0)
#define PTR(p) ((uint64_t)(uintptr_t)(p))

static size_t read_reg(uint64_t reg, uint8_t *out, size_t cap) {
  uint64_t n = register_len(reg);
  REQUIRE(n != UINT64_MAX && n <= cap, "register too large");
  read_register(reg, PTR(out));
  return (size_t)n;
}
static size_t read_input(void) { input(0); uint64_t n = register_len(0); if (n == UINT64_MAX) return 0; return read_reg(0, in, sizeof(in)); }
static void load_ids(void) {
  current_account_id(0); self_len = read_reg(0, self_id, MAX_ID);
  predecessor_account_id(0); caller_len = read_reg(0, caller, MAX_ID);
}
static uint64_t le64(const uint8_t *p) { uint64_t x = 0; for (unsigned i = 0; i < 8; i++) x |= (uint64_t)p[i] << (8 * i); return x; }
static void put64(uint8_t *p, uint64_t x) { for (unsigned i = 0; i < 8; i++) p[i] = (uint8_t)(x >> (8 * i)); }
static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static int zero(const uint8_t *p, size_t n) { unsigned x = 0; for (size_t i = 0; i < n; i++) x |= p[i]; return x == 0; }
static uint64_t add_checked(uint64_t a, uint64_t b) { REQUIRE(a + b >= a, "time overflow"); return a + b; }
static uint64_t mul_ns(uint64_t s) { REQUIRE(s <= UINT64_MAX / NS, "time overflow"); return s * NS; }

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
/* A length-prefixed, zero-padded id field: valid id, canonical padding. */
static int id_field(const uint8_t *f) { unsigned n = f[0]; return n <= MAX_ID && valid_id(f + 1, n) && zero(f + 1 + n, MAX_ID - n); }
static int id_is(const uint8_t *f, const uint8_t *id, size_t n) { return f[0] == n && memcmp(f + 1, id, n) == 0 && zero(f + 1 + n, MAX_ID - n); }

static void load_config(void) {
  REQUIRE(storage_read(1, PTR("C"), 0) == 1 && read_reg(0, cfg, CONFIG) == CONFIG, "not initialized");
  REQUIRE(storage_read(1, PTR("H"), 0) == 1 && read_reg(0, chash, 32) == 32, "not initialized");
}
static uint64_t next_nonce(void) { uint8_t b[8]; REQUIRE(storage_read(1, PTR("N"), 0) == 1 && read_reg(0, b, 8) == 8, "not initialized"); return le64(b); }
static int load_active(void) {
  if (storage_read(1, PTR("a"), 0) != 1) return 0;
  REQUIRE(read_reg(0, act, A_LEN) == A_LEN, "bad active record");
  return 1;
}
static void hash_into(const uint8_t *p, size_t n, uint8_t out[32]) { sha256(n, PTR(p), 1); REQUIRE(read_reg(1, out, 32) == 32, "sha256"); }

/* init(config): once, inside the creating transaction, by the direct parent account (one label above). */
EXPORT(init) void init(void) {
  size_t n = read_input();
  REQUIRE(n == CONFIG, "expected a 7857-byte config");
  REQUIRE(storage_read(1, PTR("C"), 0) == 0, "already initialized");
  load_ids();
  REQUIRE(self_len > caller_len + 1 && self_id[self_len - caller_len - 1] == '.' &&
          memcmp(self_id + self_len - caller_len, caller, caller_len) == 0, "init must come from the parent account");
  for (size_t i = 0; i < self_len - caller_len - 1; i++) REQUIRE(self_id[i] != '.', "init must come from the parent account");
  REQUIRE(id_field(in + C_TARGET), "bad target account id");
  REQUIRE(!id_is(in + C_TARGET, self_id, self_len), "the Guardian cannot guard itself");
  uint64_t delay = le64(in + C_DELAY), window = le64(in + C_WINDOW);
  REQUIRE(delay >= MIN_DELAY && delay <= MAX_SPAN, "delay must be 60 s to 30 days");
  REQUIRE(window >= MIN_WINDOW && window <= MAX_SPAN, "window must be 1 hour to 30 days");
  const uint8_t *k = in + C_KEYS;
  REQUIRE(memcmp(k, k + PQ87_PK, PQ87_PK) && memcmp(k, k + 2 * PQ87_PK, PQ87_PK) && memcmp(k + PQ87_PK, k + 2 * PQ87_PK, PQ87_PK),
          "signer keys must be distinct");
  hash_into(in, CONFIG, chash);
  storage_write(1, PTR("C"), CONFIG, PTR(in), 0);
  storage_write(1, PTR("H"), 32, PTR(chash), 0);
  uint8_t z[8] = { 0 };
  storage_write(1, PTR("N"), 8, PTR(z), 0);
}

/* The common validator of propose and cancel: framing, domain, payload shape, deadline, then the two approvals.
 * Returns the bitmap of approving signers. Nothing is written before it returns. */
static uint8_t validate(size_t n, uint64_t now) {
  REQUIRE(n >= ENVELOPE, "input shorter than operation and two approvals");
  const uint8_t *m = in;
  static const char chain[8] = QP_CHAIN;
  REQUIRE(memcmp(m + O_MAGIC, MAGIC, 8) == 0, "bad magic");
  REQUIRE(memcmp(m + O_CHAIN, chain, 8) == 0, "wrong network");
  REQUIRE(id_is(m + O_GUARDIAN, self_id, self_len), "operation is for another Guardian");
  REQUIRE(memcmp(m + O_TARGET, cfg + C_TARGET, 1 + MAX_ID) == 0, "operation is for another target");
  REQUIRE(memcmp(m + O_CONFIG, chash, 32) == 0, "operation is for another configuration");
  REQUIRE(now < le64(m + O_DEADLINE), "approvals expired");
  switch (m[O_ACTION]) {
    case MINT: {
      REQUIRE(id_field(m + O_PAYLOAD), "bad receiver account id");
      REQUIRE(!zero(m + O_AMOUNT, 16), "amount must be positive");
      REQUIRE(zero(m + 276, OP - 276), "reserved bytes must be zero");
      break;
    }
    case UPGRADE: {
      uint32_t len = le32(m + O_CODELEN);
      REQUIRE(len >= 1 && len <= MAX_CODE, "code length out of range");
      REQUIRE(zero(m + 239, OP - 239), "reserved bytes must be zero");
      break;
    }
    case CANCEL: REQUIRE(zero(m + 227, OP - 227), "reserved bytes must be zero"); break;
    default: fail("unknown action");
  }
  uint8_t i0 = m[OP], i1 = m[OP + APPROVAL];
  REQUIRE(i0 <= 2 && i1 <= 2 && i0 != i1, "two approvals from distinct signers required");
  const uint8_t *keys = cfg + C_KEYS;
  REQUIRE(pq87_verify(keys + i0 * PQ87_PK, PQ87_PK, m + OP + 1, PQ87_SIG, m, OP, (const uint8_t *)CONTEXT, sizeof(CONTEXT) - 1) == 0, "invalid approval");
  REQUIRE(pq87_verify(keys + i1 * PQ87_PK, PQ87_PK, m + OP + APPROVAL + 1, PQ87_SIG, m, OP, (const uint8_t *)CONTEXT, sizeof(CONTEXT) - 1) == 0, "invalid approval");
  return (uint8_t)((1u << i0) | (1u << i1));
}

static void log_nonce(const char *what, uint64_t nonce) {
  char line[96]; size_t n = 0;
  for (const char *s = what; *s; s++) line[n++] = *s;
  char d[20]; unsigned k = 0; do { d[k++] = (char)('0' + nonce % 10); nonce /= 10; } while (nonce);
  while (k) line[n++] = d[--k];
  log_utf8(n, PTR(line));
}

/* propose(operation ‖ two approvals ‖ code for an upgrade): queues a mint or upgrade. Anyone may submit it. */
EXPORT(propose) void propose(void) {
  size_t n = read_input(); load_ids(); load_config();
  uint64_t now = block_timestamp();
  uint8_t bitmap = validate(n, now);
  const uint8_t *m = in;
  REQUIRE(m[O_ACTION] == MINT || m[O_ACTION] == UPGRADE, "propose takes a mint or an upgrade");
  uint64_t nonce = next_nonce();
  REQUIRE(nonce != UINT64_MAX && le64(m + O_NONCE) == nonce, "stale or future nonce");
  REQUIRE(storage_read(1, PTR("a"), 0) == 0, "another operation is active");
  if (m[O_ACTION] == MINT) REQUIRE(n == ENVELOPE, "unexpected trailing bytes");
  else {
    uint32_t len = le32(m + O_CODELEN);
    REQUIRE(n == ENVELOPE + len, "code length does not match the operation");
    uint8_t h[32]; hash_into(in + ENVELOPE, len, h);
    REQUIRE(memcmp(h, m + O_PAYLOAD, 32) == 0, "code does not match the approved hash");
  }
  uint64_t eta = add_checked(now, mul_ns(le64(cfg + C_DELAY)));
  uint64_t expires = add_checked(eta, mul_ns(le64(cfg + C_WINDOW)));
  act[A_STATUS] = QUEUED; act[A_BITMAP] = bitmap;
  put64(act + A_QUEUED, now); put64(act + A_ETA, eta); put64(act + A_EXPIRES, expires);
  memcpy(act + A_OP, m, OP);
  storage_write(1, PTR("a"), A_LEN, PTR(act), 0);
  if (m[O_ACTION] == UPGRADE) storage_write(1, PTR("c"), le32(m + O_CODELEN), PTR(in + ENVELOPE), 0);
  uint8_t next[8]; put64(next, nonce + 1);
  storage_write(1, PTR("N"), 8, PTR(next), 0);
  log_nonce(m[O_ACTION] == MINT ? "queued mint, nonce " : "queued upgrade, nonce ", nonce);
}

/* Ends the active operation: records it as the last terminal one, deletes any queued code (a mint has none),
 * frees the slot. The nonce is never given back. */
static void terminate(uint8_t status) {
  uint8_t t[T_LEN];
  memcpy(t, act + A_OP + O_NONCE, 8);
  hash_into(act + A_OP, OP, t + 8);
  t[40] = status;
  storage_write(1, PTR("t"), T_LEN, PTR(t), 0);
  storage_remove(1, PTR("a"), 0);
  storage_remove(1, PTR("c"), 0);
}

/* cancel(cancel operation ‖ two approvals): ends a queued operation, bound by nonce and proposal hash. */
EXPORT(cancel) void cancel(void) {
  size_t n = read_input(); load_ids(); load_config();
  uint64_t now = block_timestamp();
  validate(n, now);
  REQUIRE(in[O_ACTION] == CANCEL && n == ENVELOPE, "cancel takes a cancel operation and no trailing bytes");
  REQUIRE(load_active() && act[A_STATUS] == QUEUED, "no queued operation");
  REQUIRE(memcmp(in + O_NONCE, act + A_OP + O_NONCE, 8) == 0, "cancel names another nonce");
  uint8_t h[32]; hash_into(act + A_OP, OP, h);
  REQUIRE(memcmp(h, in + O_PAYLOAD, 32) == 0, "cancel names another proposal");
  terminate('C');
  log_nonce("canceled, nonce ", le64(act + A_OP + O_NONCE));
}

static char out[2048]; static size_t on;
#define PUT(s) do { const char *s_ = (s); while (*s_) out[on++] = *s_++; } while (0)
static void put_u64(uint64_t x) { char d[20]; unsigned k = 0; do { d[k++] = (char)('0' + x % 10); x /= 10; } while (x); while (k) out[on++] = d[--k]; }
/* u128 to decimal, on four 32-bit limbs. */
static void put_u128(const uint8_t *p) {
  uint64_t lo = le64(p), hi = le64(p + 8);
  uint32_t limb[4] = { (uint32_t)(hi >> 32), (uint32_t)hi, (uint32_t)(lo >> 32), (uint32_t)lo };
  char rev[40]; size_t n = 0;
  do {
    uint64_t rem = 0; int nonzero = 0;
    for (unsigned i = 0; i < 4; i++) { uint64_t cur = (rem << 32) | limb[i]; limb[i] = (uint32_t)(cur / 10); rem = cur % 10; nonzero |= limb[i] != 0; }
    rev[n++] = (char)('0' + rem);
    if (!nonzero) break;
  } while (1);
  while (n) out[on++] = rev[--n];
}
static void put_hex(const uint8_t *p, size_t n) { static const char h[] = "0123456789abcdef"; for (size_t i = 0; i < n; i++) { out[on++] = h[p[i] >> 4]; out[on++] = h[p[i] & 15]; } }
static void put_id(const uint8_t *f) { out[on++] = '"'; memcpy(out + on, f + 1, f[0]); on += f[0]; out[on++] = '"'; }

/* execute(): anyone, once the delay has passed and before the dispatch window closes. Marks the operation
 * Executing before creating the target call, so it is dispatched once; the private on_result settles it. */
EXPORT(execute) void execute(void) {
  REQUIRE(read_input() == 0, "execute takes no input");
  load_ids(); load_config();
  REQUIRE(load_active() && act[A_STATUS] == QUEUED, "no queued operation");
  uint64_t now = block_timestamp();
  REQUIRE(now >= le64(act + A_ETA), "timelock has not passed");
  REQUIRE(now < le64(act + A_EXPIRES), "dispatch window closed");
  act[A_STATUS] = EXECUTING;
  storage_write(1, PTR("a"), A_LEN, PTR(act), 0);
  const uint8_t *m = act + A_OP, *target = cfg + C_TARGET;
  uint8_t none[16] = { 0 };
  uint64_t p;
  if (m[O_ACTION] == MINT) {
    on = 0;
    PUT("{\"receiver_id\":"); put_id(m + O_PAYLOAD); PUT(",\"amount\":\""); put_u128(m + O_AMOUNT);
    PUT("\",\"op_id\":\""); put_u64(le64(m + O_NONCE)); PUT("\"}");
    p = promise_create(target[0], PTR(target + 1), 4, PTR("mint"), on, PTR(out), PTR(none), TARGET_MINT_GAS);
  } else {
    uint32_t len = le32(m + O_CODELEN);
    REQUIRE(storage_read(1, PTR("c"), 0) == 1 && read_reg(0, in + 16, MAX_CODE) == len, "queued code missing");
    memcpy(in, m + O_NONCE, 8); memcpy(in + 8, m + O_FROM, 4); memcpy(in + 12, m + O_TO, 4);
    p = promise_create(target[0], PTR(target + 1), 7, PTR("upgrade"), 16 + len, PTR(in), PTR(none), TARGET_UPGRADE_GAS);
  }
  promise_then(p, self_len, PTR(self_id), 9, PTR("on_result"), 8, PTR(m + O_NONCE), PTR(none), CALLBACK_GAS);
  log_nonce("dispatched, nonce ", le64(m + O_NONCE));
}

/* on_result(nonce): private callback of execute. Reads only the promise status, never its return bytes. */
EXPORT(on_result) void on_result(void) {
  size_t n = read_input(); load_ids();
  REQUIRE(caller_len == self_len && memcmp(caller, self_id, self_len) == 0, "private");
#ifdef FAIL_CALLBACK
  fail("callback refused (test build)");
#endif
  REQUIRE(promise_results_count() == 1, "one result expected");
  REQUIRE(n == 8 && load_active() && act[A_STATUS] == EXECUTING && memcmp(in, act + A_OP + O_NONCE, 8) == 0, "no matching executing operation");
  uint64_t r = promise_result(0, 2);
  REQUIRE(r == 1 || r == 2, "unexpected promise status");
  terminate(r == 1 ? 'A' : 'F');
  log_nonce(r == 1 ? "applied, nonce " : "failed, nonce ", le64(act + A_OP + O_NONCE));
}

/* expire(): anyone, once a queued operation's dispatch window has closed. */
EXPORT(expire) void expire(void) {
  REQUIRE(read_input() == 0, "expire takes no input");
  REQUIRE(load_active() && act[A_STATUS] == QUEUED, "no queued operation");
  REQUIRE(block_timestamp() >= le64(act + A_EXPIRES), "dispatch window still open");
  terminate('E');
  log_nonce("expired, nonce ", le64(act + A_OP + O_NONCE));
}

/* View: configuration, next nonce, the active operation in full (message bytes and decoded fields), the last
 * terminal record. Times are nanoseconds as decimal strings. */
EXPORT(state) void state(void) {
  load_config();
  on = 0;
  PUT("{\"version\":\"" CONTEXT "\",\"chain\":\"" QP_CHAIN "\",\"target\":"); put_id(cfg + C_TARGET);
  PUT(",\"config_sha256\":\""); put_hex(chash, 32);
  PUT("\",\"delay_seconds\":"); put_u64(le64(cfg + C_DELAY));
  PUT(",\"window_seconds\":"); put_u64(le64(cfg + C_WINDOW));
  PUT(",\"signer_key_sha256\":[");
  for (unsigned i = 0; i < 3; i++) { uint8_t h[32]; hash_into(cfg + C_KEYS + i * PQ87_PK, PQ87_PK, h); if (i) PUT(","); PUT("\""); put_hex(h, 32); PUT("\""); }
  PUT("],\"next_nonce\":\""); put_u64(next_nonce()); PUT("\",\"active\":");
  if (load_active()) {
    const uint8_t *m = act + A_OP; uint8_t h[32]; hash_into(m, OP, h);
    PUT("{\"status\":\""); PUT(act[A_STATUS] == QUEUED ? "queued" : "executing");
    PUT("\",\"nonce\":\""); put_u64(le64(m + O_NONCE)); PUT("\",\"proposal_hash\":\""); put_hex(h, 32);
    PUT("\",\"action\":\""); PUT(m[O_ACTION] == MINT ? "mint" : "upgrade"); PUT("\"");
    if (m[O_ACTION] == MINT) { PUT(",\"receiver_id\":"); put_id(m + O_PAYLOAD); PUT(",\"amount\":\""); put_u128(m + O_AMOUNT); PUT("\""); }
    else {
      PUT(",\"code_sha256\":\""); put_hex(m + O_PAYLOAD, 32); PUT("\",\"code_length\":"); put_u64(le32(m + O_CODELEN));
      PUT(",\"from_version\":"); put_u64(le32(m + O_FROM)); PUT(",\"to_version\":"); put_u64(le32(m + O_TO));
    }
    PUT(",\"queued_at_ns\":\""); put_u64(le64(act + A_QUEUED)); PUT("\",\"eta_ns\":\""); put_u64(le64(act + A_ETA));
    PUT("\",\"expires_ns\":\""); put_u64(le64(act + A_EXPIRES)); PUT("\",\"signers\":"); put_u64(act[A_BITMAP]);
    PUT(",\"message_hex\":\""); put_hex(m, OP); PUT("\"}");
  } else PUT("null");
  PUT(",\"last\":");
  uint8_t t[T_LEN];
  if (storage_read(1, PTR("t"), 0) == 1 && read_reg(0, t, T_LEN) == T_LEN) {
    const char *s = t[40] == 'A' ? "applied" : t[40] == 'F' ? "failed" : t[40] == 'C' ? "canceled" : "expired";
    PUT("{\"nonce\":\""); put_u64(le64(t)); PUT("\",\"proposal_hash\":\""); put_hex(t + 8, 32); PUT("\",\"status\":\""); PUT(s); PUT("\"}");
  } else PUT("null");
  PUT("}");
  value_return(on, PTR(out));
}
