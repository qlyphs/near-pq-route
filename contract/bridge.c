/* Qlyphs PQ bridge, NEAR side: a fungible token (NEP-141 subset) for QTC locked on Quantus. It mints only
 * when two of three fixed ML-DSA-87 attesters sign the exact deposit (Quantus deposit id, amount, receiver),
 * once per deposit, and burns on redeem with a Quantus destination that the attesters release to.
 * Keyless after deployment: no owner, no upgrade, no attester rotation. Protocol: docs/ROUTE.md. */
#include <stdint.h>
#include <stddef.h>
#include "../core/pq87.h"
#include "../core/memory.h"
#ifdef QP_BENCH
#error "the bridge is never built with the profiling opcodes"
#endif
#ifndef QP_CHAIN
#error "build with -DQP_CHAIN='\"testnet\"' (or sandbox): the network this binary serves"
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
IMPORT(attached_deposit) void attached_deposit(uint64_t ptr);
IMPORT(block_index) uint64_t block_index(void);
IMPORT(prepaid_gas) uint64_t prepaid_gas(void);
IMPORT(used_gas) uint64_t used_gas(void);
IMPORT(promise_create) uint64_t promise_create(uint64_t alen, uint64_t aptr, uint64_t mlen, uint64_t mptr,
  uint64_t arglen, uint64_t argptr, uint64_t amount_ptr, uint64_t gas);
IMPORT(promise_then) uint64_t promise_then(uint64_t idx, uint64_t alen, uint64_t aptr, uint64_t mlen, uint64_t mptr,
  uint64_t arglen, uint64_t argptr, uint64_t amount_ptr, uint64_t gas);
IMPORT(promise_return) void promise_return(uint64_t idx);
IMPORT(promise_batch_create) uint64_t promise_batch_create(uint64_t len, uint64_t ptr);
IMPORT(promise_batch_action_transfer) void promise_batch_action_transfer(uint64_t idx, uint64_t amount_ptr);
IMPORT(promise_results_count) uint64_t promise_results_count(void);
IMPORT(promise_result) uint64_t promise_result(uint64_t idx, uint64_t reg);
IMPORT(sha256) void sha256(uint64_t len, uint64_t ptr, uint64_t reg);

#define CONTEXT "qlyphs/near-bridge/v1"
#define MAGIC "QLYPBRG1"
#define MAX_ID 64u
#define MSG 288u
#define SIGNED (1u + PQ87_SIG)
#define MAX_RECEIPT 2048u
#define MAX_INPUT (MSG + 2u * SIGNED + 2u + MAX_RECEIPT)
#define CONFIG (32u + 3u * PQ87_PK)
#define A_MODE 258u               /* 0: credit the receiver; 1: deposit into the configured Intents verifier for the receiver */
#define MIN_STORAGE_LO 14068147061460041728ULL   /* 0.00125 NEAR (1.25e21 yocto) to register a holder */
#define MIN_STORAGE_HI 67ULL
#define MAX_PAGE 8u
#define MIN_WITHDRAW 10000000000ULL   /* 0.01 QTC in planck: the smallest burn the attesters release */
#define TGAS 1000000000000ULL
#define RESOLVE_GAS (10 * TGAS)
#define WITHDRAW "WITHDRAW_TO:"

/* Attestation offsets (docs/ROUTE.md). */
enum { A_MAGIC = 0, A_CHAIN = 8, A_BRIDGE = 16, A_GENESIS = 81, A_DEPOSIT = 113, A_AMOUNT = 145, A_RECV = 161,
       A_RECEIPT = 226, A_ZERO = 258 };

/* Storage keys: "c" config (Quantus genesis | 3 public keys), "s" supply (u128), "b<account>" balance (u128),
 * "d<deposit id>" consumed deposit, "n" receipt count, "r<u64>" receipt, "m" redemption count,
 * "x<u64>" redemption: amount u128 | Quantus destination 32 | block u64 | account length u8 | account. */
static uint8_t in[MAX_INPUT];
static uint8_t self_id[MAX_ID], caller[MAX_ID], who[MAX_ID], key[1 + MAX_ID];
static size_t self_len, caller_len;
static uint8_t cfg[CONFIG];

static void fail(const char *m) { size_t n = 0; while (m[n]) n++; panic_utf8(n, (uint64_t)(uintptr_t)m); }
#define REQUIRE(c, m) do { if (!(c)) fail(m); } while (0)
#define PTR(p) ((uint64_t)(uintptr_t)(p))

static size_t read_reg(uint64_t reg, uint8_t *out, size_t cap) {
  uint64_t n = register_len(reg);
  REQUIRE(n != UINT64_MAX && n <= cap, "register too large");
  read_register(reg, PTR(out));
  return (size_t)n;
}
static void load_ids(void) {
  current_account_id(0); self_len = read_reg(0, self_id, MAX_ID);
  predecessor_account_id(0); caller_len = read_reg(0, caller, MAX_ID);
}
static int same(const uint8_t *a, size_t an, const uint8_t *b, size_t bn) { return an == bn && memcmp(a, b, an) == 0; }
static uint64_t le64(const uint8_t *p) { uint64_t x = 0; for (unsigned i = 0; i < 8; i++) x |= (uint64_t)p[i] << (8 * i); return x; }
static void put64(uint8_t *p, uint64_t x) { for (unsigned i = 0; i < 8; i++) p[i] = (uint8_t)(x >> (8 * i)); }

/* NEAR account id grammar; also keeps ids safe inside JSON strings. */
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

/* 128-bit amounts on two 64-bit halves (no __int128 in a -nostdlib build). */
typedef struct { uint64_t lo, hi; } u128;
static u128 rd128(const uint8_t *p) { u128 x = { le64(p), le64(p + 8) }; return x; }
static void wr128(uint8_t *p, u128 x) { put64(p, x.lo); put64(p + 8, x.hi); }
static int lt128(u128 a, u128 b) { return a.hi < b.hi || (a.hi == b.hi && a.lo < b.lo); }
static int is0(u128 a) { return (a.lo | a.hi) == 0; }
static u128 add128(u128 a, u128 b) {
  u128 r = { a.lo + b.lo, a.hi + b.hi + (a.lo + b.lo < a.lo) };
  REQUIRE(!lt128(r, a), "amount overflow");
  return r;
}
static u128 sub128(u128 a, u128 b) { REQUIRE(!lt128(a, b), "insufficient balance"); u128 r = { a.lo - b.lo, a.hi - b.hi - (a.lo < b.lo) }; return r; }
static u128 mul10add(u128 a, unsigned d) {
  /* a * 10 + d, refusing overflow: (a << 3) + (a << 1) + d */
  REQUIRE(a.hi < (1ULL << 61), "amount overflow"); /* the shift by 3 needs hi < 2^61; add128 catches the rest */
  u128 a8 = { a.lo << 3, (a.hi << 3) | (a.lo >> 61) }, a2 = { a.lo << 1, (a.hi << 1) | (a.lo >> 63) }, dd = { d, 0 };
  return add128(add128(a8, a2), dd);
}
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

/* Strict JSON input: one flat object whose values are all strings, fully consumed. Field names are
 * [a-z_]; values are printable ASCII without quotes or backslashes (no escapes anywhere). Every field must
 * be one the method allows, and none may appear twice, so the contract reads exactly what JSON.parse reads
 * or refuses the input. */
typedef struct { const uint8_t *k, *v; size_t kl, vl; } field;
#define MAX_FIELDS 4
static field fields[MAX_FIELDS];
static size_t nfields;
static size_t skip_ws(const uint8_t *j, size_t n, size_t i) { while (i < n && (j[i] == ' ' || j[i] == '\t' || j[i] == '\n' || j[i] == '\r')) i++; return i; }
static size_t str_end(const uint8_t *j, size_t n, size_t i, int name) {
  while (i < n && j[i] != '"') {
    uint8_t c = j[i];
    if (name) REQUIRE((c >= 'a' && c <= 'z') || c == '_', "unsupported JSON field name");
    else REQUIRE(c >= 0x20 && c < 0x7f && c != '\\', "unsupported character in a JSON string");
    i++;
  }
  REQUIRE(i < n, "unterminated JSON string");
  return i;
}
static int name_is(const field *f, const char *name) { size_t l = 0; while (name[l]) l++; return f->kl == l && memcmp(f->k, name, l) == 0; }
/* allowed: space-separated field names this method accepts. */
static void parse_json(const uint8_t *j, size_t n, const char *allowed) {
  nfields = 0;
  size_t i = skip_ws(j, n, 0);
  REQUIRE(i < n && j[i] == '{', "expected a JSON object");
  i = skip_ws(j, n, i + 1);
  if (i < n && j[i] == '}') i++;
  else for (;;) {
    REQUIRE(i < n && j[i] == '"', "expected a JSON field name");
    size_t ke = str_end(j, n, i + 1, 1);
    field f = { j + i + 1, 0, ke - i - 1, 0 };
    i = skip_ws(j, n, ke + 1);
    REQUIRE(i < n && j[i] == ':', "expected ':'");
    i = skip_ws(j, n, i + 1);
    /* null (and true/false for registration_only): near-sdk sends optional fields this way. The name is checked
     * like any other and recorded, so duplicates are refused; get_field reports it as absent. */
    size_t lit = (i + 4 <= n && memcmp(j + i, "null", 4) == 0) ? 4
      : (i + 4 <= n && memcmp(j + i, "true", 4) == 0 && name_is(&f, "registration_only")) ? 4
      : (i + 5 <= n && memcmp(j + i, "false", 5) == 0 && name_is(&f, "registration_only")) ? 5 : 0;
    if (lit) {
      for (size_t k = 0; k < nfields; k++) REQUIRE(!(fields[k].kl == f.kl && memcmp(fields[k].k, f.k, f.kl) == 0), "duplicate JSON field");
      int okl = 0;
      for (const char *a = allowed; *a;) { const char *e = a; while (*e && *e != ' ') e++; if ((size_t)(e - a) == f.kl && memcmp(a, f.k, f.kl) == 0) okl = 1; a = *e ? e + 1 : e; }
      REQUIRE(okl, "unexpected JSON field");
      REQUIRE(nfields < MAX_FIELDS, "too many JSON fields");
      f.v = 0; f.vl = 0; fields[nfields++] = f;
      i = skip_ws(j, n, i + lit);
      REQUIRE(i < n, "unterminated JSON object");
      if (j[i] == ',') { i = skip_ws(j, n, i + 1); continue; }
      REQUIRE(j[i] == '}', "expected ',' or '}'");
      i++;
      break;
    }
    REQUIRE(i < n && j[i] == '"', "JSON values must be strings");
    size_t ve = str_end(j, n, i + 1, 0);
    f.v = j + i + 1; f.vl = ve - i - 1;
    REQUIRE(nfields < MAX_FIELDS, "too many JSON fields");
    for (size_t k = 0; k < nfields; k++) REQUIRE(!(fields[k].kl == f.kl && memcmp(fields[k].k, f.k, f.kl) == 0), "duplicate JSON field");
    int ok = 0;
    for (const char *a = allowed; *a;) {
      const char *e = a; while (*e && *e != ' ') e++;
      if ((size_t)(e - a) == f.kl && memcmp(a, f.k, f.kl) == 0) ok = 1;
      a = *e ? e + 1 : e;
    }
    REQUIRE(ok, "unexpected JSON field");
    fields[nfields++] = f;
    i = skip_ws(j, n, ve + 1);
    REQUIRE(i < n, "unterminated JSON object");
    if (j[i] == ',') { i = skip_ws(j, n, i + 1); continue; }
    REQUIRE(j[i] == '}', "expected ',' or '}'");
    i++;
    break;
  }
  REQUIRE(skip_ws(j, n, i) == n, "trailing data after the JSON object");
}
static const field *get_field(const char *name) { for (size_t k = 0; k < nfields; k++) if (name_is(&fields[k], name)) return fields[k].v ? &fields[k] : 0; return 0; }
static size_t json_id(const char *name, uint8_t *out) {
  const field *f = get_field(name);
  REQUIRE(f && valid_id(f->v, f->vl), "missing or invalid account id");
  memcpy(out, f->v, f->vl);
  return f->vl;
}
static u128 json_u128(const char *name, int required, int *present) {
  const field *f = get_field(name);
  u128 x = { 0, 0 };
  if (present) *present = f != 0;
  if (!f) { REQUIRE(!required, "missing number"); return x; }
  REQUIRE(f->vl >= 1 && f->vl <= 39 && (f->vl == 1 || f->v[0] != '0'), "bad number");
  for (size_t i = 0; i < f->vl; i++) { REQUIRE(f->v[i] >= '0' && f->v[i] <= '9', "bad number"); x = mul10add(x, f->v[i] - '0'); }
  return x;
}


static uint64_t rd_u64_key(const char *k) { uint8_t b[8]; if (storage_read(1, PTR(k), 0) != 1) return 0; REQUIRE(read_reg(0, b, 8) == 8, "bad counter"); return le64(b); }
static void wr_u64_key(const char *k, uint64_t x) { uint8_t b[8]; put64(b, x); storage_write(1, PTR(k), 8, PTR(b), 0); }
static void load_config(void) { REQUIRE(storage_read(1, PTR("c"), 0) == 1 && read_reg(0, cfg, CONFIG) == CONFIG, "not initialized"); }

static u128 supply(void) { uint8_t b[16]; u128 z = { 0, 0 }; if (storage_read(1, PTR("s"), 0) != 1) return z; REQUIRE(read_reg(0, b, 16) == 16, "bad supply"); return rd128(b); }
static void set_supply(u128 x) { uint8_t b[16]; wr128(b, x); storage_write(1, PTR("s"), 16, PTR(b), 0); }
static int registered(const uint8_t *id, size_t n) { key[0] = 'b'; memcpy(key + 1, id, n); return storage_read(1 + n, PTR(key), 0) == 1; }
static u128 balance(const uint8_t *id, size_t n) {
  key[0] = 'b'; memcpy(key + 1, id, n);
  u128 z = { 0, 0 }; uint8_t b[16];
  if (storage_read(1 + n, PTR(key), 0) != 1) return z;
  REQUIRE(read_reg(0, b, 16) == 16, "bad balance");
  return rd128(b);
}
static void set_balance(const uint8_t *id, size_t n, u128 x) {
  key[0] = 'b'; memcpy(key + 1, id, n); uint8_t b[16]; wr128(b, x);
  storage_write(1 + n, PTR(key), 16, PTR(b), 0);
}

static char out[40960]; static size_t on;
#define PUT(s) do { const char *s_ = (s); while (*s_) out[on++] = *s_++; } while (0)
static void put_bytes(const uint8_t *p, size_t n) { memcpy(out + on, p, n); on += n; }
static void put_u128(u128 x) { char d[40]; size_t n = dec128(x, d); memcpy(out + on, d, n); on += n; }
static void put_u64(uint64_t x) { u128 y = { x, 0 }; put_u128(y); }
static void put_hex(const uint8_t *p, size_t n) { static const char h[] = "0123456789abcdef"; for (size_t i = 0; i < n; i++) { out[on++] = h[p[i] >> 4]; out[on++] = h[p[i] & 15]; } }
static int unhex(uint8_t c) { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; return -1; }

static void emit(const char *event, const uint8_t *owner, size_t olen, u128 amount, const uint8_t *to, size_t tlen) {
  on = 0;
  PUT("EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\""); PUT(event); PUT("\",\"data\":[{");
  if (to) { PUT("\"old_owner_id\":\""); put_bytes(owner, olen); PUT("\",\"new_owner_id\":\""); put_bytes(to, tlen); }
  else { PUT("\"owner_id\":\""); put_bytes(owner, olen); }
  PUT("\",\"amount\":\""); put_u128(amount); PUT("\"}]}");
  log_utf8(on, PTR(out));
}

/* new(genesis 32 | key 1 | key 2 | key 3 | verifier id length u8 | verifier id): once, by the parent account in
 * the batch that creates the bridge account and deploys this code. The verifier is the NEAR Intents contract deposits can go into. */
EXPORT(new) void new_(void) {
  input(0); size_t n = read_reg(0, in, sizeof(in)); load_ids();
  /* Only the direct parent, inside the batch that creates and deploys the account: the bridge never holds a key. */
  REQUIRE(self_len > caller_len + 1 && self_id[self_len - caller_len - 1] == '.' && memcmp(self_id + self_len - caller_len, caller, caller_len) == 0, "init must come from the parent account");
  for (size_t k = 0; k + caller_len + 1 < self_len; k++) REQUIRE(self_id[k] != '.', "init must come from the direct parent account");
  REQUIRE(storage_read(1, PTR("c"), 0) != 1, "already initialized");
  REQUIRE(n > CONFIG + 1 && n == CONFIG + 1 + in[CONFIG] && valid_id(in + CONFIG + 1, in[CONFIG]), "config is genesis, three ML-DSA-87 public keys and the Intents verifier id");
  REQUIRE(!same(in + CONFIG + 1, in[CONFIG], self_id, self_len), "the verifier cannot be the bridge");
  storage_write(1, PTR("i"), in[CONFIG], PTR(in + CONFIG + 1), 0);
  const uint8_t *k = in + 32;
  REQUIRE(memcmp(k, k + PQ87_PK, PQ87_PK) && memcmp(k, k + 2 * PQ87_PK, PQ87_PK) && memcmp(k + PQ87_PK, k + 2 * PQ87_PK, PQ87_PK), "attester keys must differ");
  storage_write(1, PTR("c"), CONFIG, PTR(in), 0);
  u128 z = { 0, 0 }; set_supply(z);
}

static size_t read_id_key(const char *k, uint8_t *o) { if (storage_read(1, PTR(k), 0) != 1) return 0; return read_reg(0, o, MAX_ID); }

/* receiver.ft_on_transfer(sender, amount, msg) then self.ft_resolve_transfer(sender, receiver, amount), returned. */
static void call_on_transfer(const uint8_t *snd, size_t sl, const uint8_t *rcv, size_t rl, u128 amount, const uint8_t *msg, size_t ml) {
  uint64_t used = used_gas(), pre = prepaid_gas();
  REQUIRE(pre > used + RESOLVE_GAS + 15 * TGAS, "not enough gas for the receiver call");
  uint64_t call_gas = pre - used - RESOLVE_GAS - 5 * TGAS;
  static uint8_t args[2400]; size_t a = 0; char d[40]; size_t k;
#define ADD(s) do { const char *s_ = (s); while (*s_) args[a++] = (uint8_t)*s_++; } while (0)
  ADD("{\"sender_id\":\""); memcpy(args + a, snd, sl); a += sl;
  ADD("\",\"amount\":\""); k = dec128(amount, d); memcpy(args + a, d, k); a += k;
  ADD("\",\"msg\":\""); memcpy(args + a, msg, ml); a += ml; ADD("\"}");
  uint8_t zero[16] = { 0 };
  uint64_t p = promise_create(rl, PTR(rcv), 14, PTR("ft_on_transfer"), a, PTR(args), PTR(zero), call_gas);
  a = 0;
  ADD("{\"sender_id\":\""); memcpy(args + a, snd, sl); a += sl;
  ADD("\",\"receiver_id\":\""); memcpy(args + a, rcv, rl); a += rl;
  ADD("\",\"amount\":\""); k = dec128(amount, d); memcpy(args + a, d, k); a += k;
  ADD("\"}");
#undef ADD
  uint64_t q = promise_then(p, self_len, PTR(self_id), 19, PTR("ft_resolve_transfer"), a, PTR(args), PTR(zero), RESOLVE_GAS);
  promise_return(q);
}

/* mint(attestation 288 | i u8 | sig | j u8 | sig | receipt length u16 | receipt): anyone may submit. Both
 * signatures cover the same attestation, from two different attesters; each deposit mints once. */
EXPORT(mint) void mint(void) {
  input(0); size_t n = read_reg(0, in, sizeof(in)); load_ids(); load_config();
  REQUIRE(n >= MSG + 2 * SIGNED + 2, "bad mint input");
  const uint8_t *m = in;
  uint8_t i = in[MSG], j = in[MSG + SIGNED];
  size_t rl = (size_t)in[MSG + 2 * SIGNED] | (size_t)in[MSG + 2 * SIGNED + 1] << 8;
  const uint8_t *receipt = in + MSG + 2 * SIGNED + 2;
  REQUIRE(rl <= MAX_RECEIPT && n == MSG + 2 * SIGNED + 2 + rl, "bad receipt length");
  REQUIRE(i < 3 && j < 3 && i != j, "two different attesters are required");
  REQUIRE(memcmp(m + A_MAGIC, MAGIC, 8) == 0, "not a bridge attestation");
  uint8_t chain[8] = { 0 }; { const char *c = QP_CHAIN; for (unsigned k = 0; c[k] && k < 8; k++) chain[k] = (uint8_t)c[k]; }
  REQUIRE(memcmp(m + A_CHAIN, chain, 8) == 0, "attestation is for another network");
  REQUIRE(m[A_BRIDGE] == self_len && memcmp(m + A_BRIDGE + 1, self_id, self_len) == 0, "attestation is for another bridge");
  for (size_t k = A_BRIDGE + 1 + self_len; k < A_GENESIS; k++) REQUIRE(m[k] == 0, "bad padding");
  REQUIRE(memcmp(m + A_GENESIS, cfg, 32) == 0, "attestation is for another Quantus chain");
  u128 amount = rd128(m + A_AMOUNT);
  REQUIRE(!is0(amount), "amount must be positive");
  size_t wl = m[A_RECV];
  REQUIRE(wl <= MAX_ID && valid_id(m + A_RECV + 1, wl), "bad receiver");
  for (size_t k = A_RECV + 1 + wl; k < A_RECEIPT; k++) REQUIRE(m[k] == 0, "bad padding");
  REQUIRE(m[A_MODE] <= 1, "unknown mint mode");
  for (size_t k = A_MODE + 1; k < MSG; k++) REQUIRE(m[k] == 0, "bad padding");
  uint8_t h[32] = { 0 };
  if (rl) { sha256(rl, PTR(receipt), 0); REQUIRE(read_reg(0, h, 32) == 32, "sha256"); }
  REQUIRE(memcmp(m + A_RECEIPT, h, 32) == 0, "receipt does not match the attestation");
  uint8_t dk[33]; dk[0] = 'd'; memcpy(dk + 1, m + A_DEPOSIT, 32);
  REQUIRE(storage_read(33, PTR(dk), 0) != 1, "deposit already minted");
  const uint8_t *keys = cfg + 32;
  REQUIRE(pq87_verify(keys + i * PQ87_PK, PQ87_PK, in + MSG + 1, PQ87_SIG, m, MSG, (const uint8_t *)CONTEXT, sizeof(CONTEXT) - 1) == 0, "invalid attestation signature");
  REQUIRE(pq87_verify(keys + j * PQ87_PK, PQ87_PK, in + MSG + SIGNED + 1, PQ87_SIG, m, MSG, (const uint8_t *)CONTEXT, sizeof(CONTEXT) - 1) == 0, "invalid attestation signature");
  uint8_t one = 1; storage_write(33, PTR(dk), 1, PTR(&one), 0);
  memcpy(who, m + A_RECV + 1, wl);
  set_supply(add128(supply(), amount));
  uint8_t mode = m[A_MODE];
  uint8_t ver[MAX_ID]; size_t vl = 0;
  if (mode == 1) { vl = read_id_key("i", ver); REQUIRE(vl, "no verifier configured"); }
  if (mode == 1) set_balance(ver, vl, add128(balance(ver, vl), amount));
  else set_balance(who, wl, add128(balance(who, wl), amount));
  if (rl) {
    uint64_t r = rd_u64_key("n");
    uint8_t rk[9]; rk[0] = 'r'; put64(rk + 1, r);
    storage_write(9, PTR(rk), rl, PTR(receipt), 0);
    wr_u64_key("n", r + 1);
  }
  on = 0; PUT("bridge_mint deposit="); put_hex(m + A_DEPOSIT, 32); log_utf8(on, PTR(out));
  if (mode == 0) { emit("ft_mint", who, wl, amount, 0, 0); return; }
  /* Mode 1, like a PoA ft_deposit with a message: the tokens go to the verifier, which credits the receiver
   * (msg = receiver id); if it refuses, ft_resolve_transfer moves them to the receiver instead. */
  emit("ft_mint", ver, vl, amount, 0, 0);
  call_on_transfer(who, wl, ver, vl, amount, who, wl);
}

/* NEP-145, fixed storage: one registration costs 0.00125 NEAR and never changes. */
static void put_storage_balance(void) { PUT("{\"total\":\"1250000000000000000000\",\"available\":\"0\"}"); }

/* storage_deposit({"account_id"?, "registration_only"?}): registers a holder (balance 0). Attach at least 0.00125
 * NEAR; anything above, or everything when the account is already registered, goes back to the caller. */
EXPORT(storage_deposit) void storage_deposit(void) {
  input(0); size_t n = read_reg(0, in, 1024); load_ids();
  uint8_t dep[16]; attached_deposit(PTR(dep));
  u128 d = rd128(dep), min = { MIN_STORAGE_LO, MIN_STORAGE_HI }, refund = d;
  size_t wl;
  if (n) { parse_json(in, n, "account_id registration_only"); if (get_field("account_id")) wl = json_id("account_id", who); else { memcpy(who, caller, caller_len); wl = caller_len; } }
  else { memcpy(who, caller, caller_len); wl = caller_len; }
  if (!registered(who, wl)) {
    REQUIRE(!lt128(d, min), "attach at least 0.00125 NEAR");
    u128 z = { 0, 0 }; set_balance(who, wl, z);
    refund = sub128(d, min);
  }
  if (!is0(refund)) { uint8_t r[16]; wr128(r, refund); uint64_t p = promise_batch_create(caller_len, PTR(caller)); promise_batch_action_transfer(p, PTR(r)); }
  on = 0; put_storage_balance(); value_return(on, PTR(out));
}
EXPORT(storage_balance_of) void storage_balance_of(void) {
  input(0); size_t n = read_reg(0, in, 1024);
  parse_json(in, n, "account_id");
  size_t al = json_id("account_id", who);
  on = 0; if (registered(who, al)) put_storage_balance(); else PUT("null");
  value_return(on, PTR(out));
}
EXPORT(storage_balance_bounds) void storage_balance_bounds(void) {
  on = 0; PUT("{\"min\":\"1250000000000000000000\",\"max\":\"1250000000000000000000\"}"); value_return(on, PTR(out));
}

/* Burns amount from the caller and records the 32-byte Quantus account given as 64 lowercase hex characters. */
static void burn_to_quantus(u128 amount, const uint8_t *hex64) {
  uint8_t rec[16 + 32 + 8 + 1 + MAX_ID], nz = 0;
  for (unsigned k = 0; k < 32; k++) { int a = unhex(hex64[2 * k]), b = unhex(hex64[2 * k + 1]); REQUIRE(a >= 0 && b >= 0, "quantus_to is lowercase hex"); rec[16 + k] = (uint8_t)(a << 4 | b); nz |= rec[16 + k]; }
  REQUIRE(nz, "quantus_to is zero");
  u128 min = { MIN_WITHDRAW, 0 };
  REQUIRE(!lt128(amount, min), "below the minimum withdrawal of 0.01 QTC");
  set_balance(caller, caller_len, sub128(balance(caller, caller_len), amount));
  set_supply(sub128(supply(), amount));
  wr128(rec, amount); put64(rec + 48, block_index()); rec[56] = (uint8_t)caller_len; memcpy(rec + 57, caller, caller_len);
  uint64_t x = rd_u64_key("m");
  uint8_t xk[9]; xk[0] = 'x'; put64(xk + 1, x);
  storage_write(9, PTR(xk), 57 + caller_len, PTR(rec), 0);
  wr_u64_key("m", x + 1);
  emit("ft_burn", caller, caller_len, amount, 0, 0);
  on = 0; PUT("bridge_redeem id="); put_u64(x); log_utf8(on, PTR(out));
}
static void one_yocto(void) {
  uint8_t dep[16]; attached_deposit(PTR(dep));
  REQUIRE(le64(dep) == 1 && le64(dep + 8) == 0, "requires attached deposit of exactly 1 yoctoNEAR");
}
/* Moves amount from the caller to a registered holder. */
static void move(const uint8_t *to, size_t tl, u128 amount) {
  REQUIRE(!same(to, tl, caller, caller_len), "sender and receiver are the same");
  REQUIRE(registered(to, tl), "receiver is not a registered holder");
  REQUIRE(!is0(amount), "amount must be positive");
  set_balance(caller, caller_len, sub128(balance(caller, caller_len), amount));
  set_balance(to, tl, add128(balance(to, tl), amount));
  emit("ft_transfer", caller, caller_len, amount, to, tl);
}

/* ft_transfer({"receiver_id","amount","memo"?}) with exactly 1 yoctoNEAR; the receiver must be registered.
 * A transfer to the bridge itself with memo "WITHDRAW_TO:<64 hex>" is a redeem: the convention the
 * NEAR Intents verifier uses for ft_withdraw on bridged tokens. */
EXPORT(ft_transfer) void ft_transfer(void) {
  input(0); size_t n = read_reg(0, in, 1024); load_ids(); one_yocto();
  parse_json(in, n, "receiver_id amount memo");
  size_t rl = json_id("receiver_id", who);
  u128 amount = json_u128("amount", 1, 0);
  if (same(who, rl, self_id, self_len)) {
    const field *m = get_field("memo");
    REQUIRE(m && m->vl == 12 + 64 && memcmp(m->v, WITHDRAW, 12) == 0, "a transfer to the bridge needs memo WITHDRAW_TO:<64 hex Quantus account>");
    load_config(); burn_to_quantus(amount, m->v + 12);
    return;
  }
  move(who, rl, amount);
}

/* ft_transfer_call({"receiver_id","amount","memo"?,"msg"}) with exactly 1 yoctoNEAR (NEP-141): transfers, calls
 * receiver.ft_on_transfer, then ft_resolve_transfer refunds what the receiver returns as unused. */
EXPORT(ft_transfer_call) void ft_transfer_call(void) {
  input(0); size_t n = read_reg(0, in, 2048); load_ids(); one_yocto();
  parse_json(in, n, "receiver_id amount memo msg");
  size_t rl = json_id("receiver_id", who);
  REQUIRE(!same(who, rl, self_id, self_len), "use ft_transfer to redeem");
  u128 amount = json_u128("amount", 1, 0);
  const field *msg = get_field("msg");
  REQUIRE(msg, "msg is required");
  move(who, rl, amount);
  call_on_transfer(caller, caller_len, who, rl, amount, msg->v, msg->vl);
}

/* ft_resolve_transfer({"sender_id","receiver_id","amount"}): private callback. The receiver returned the unused
 * amount as a JSON string; on failure everything is unused. Refunds min(unused, receiver balance) to the sender
 * and returns the amount actually kept. */
EXPORT(ft_resolve_transfer) void ft_resolve_transfer(void) {
  input(0); size_t n = read_reg(0, in, 1024); load_ids();
  REQUIRE(same(caller, caller_len, self_id, self_len), "private");
  parse_json(in, n, "sender_id receiver_id amount");
  uint8_t snd[MAX_ID]; size_t sl = json_id("sender_id", snd);
  size_t rl = json_id("receiver_id", who);
  u128 amount = json_u128("amount", 1, 0), unused = amount;
  REQUIRE(promise_results_count() == 1, "one promise result expected");
  if (promise_result(0, 1) == 1) {
    uint8_t r[64]; uint64_t len = register_len(1);
    if (len >= 3 && len <= 41) {
      read_register(1, PTR(r));
      if (r[0] == '"' && r[len - 1] == '"') {
        /* The receiver's answer is untrusted: anything that is not a decimal u128 counts as nothing used. */
        u128 x = { 0, 0 }; int ok = len - 2 <= 39;
        for (uint64_t k = 1; ok && k + 1 < len; k++) {
          if (r[k] < '0' || r[k] > '9' || x.hi >= (1ULL << 60)) { ok = 0; break; }
          u128 a8 = { x.lo << 3, (x.hi << 3) | (x.lo >> 61) }, a2 = { x.lo << 1, (x.hi << 1) | (x.lo >> 63) }, d = { (uint64_t)(r[k] - '0'), 0 };
          u128 t = { a8.lo + a2.lo, a8.hi + a2.hi + (a8.lo + a2.lo < a8.lo) };
          u128 y = { t.lo + d.lo, t.hi + (t.lo + d.lo < t.lo) };
          if (lt128(y, t)) { ok = 0; break; }
          x = y;
        }
        if (ok) unused = lt128(amount, x) ? amount : x;
      }
    }
  }
  if (!is0(unused)) {
    u128 rb = balance(who, rl), back = lt128(rb, unused) ? rb : unused;
    if (!is0(back)) {
      set_balance(who, rl, sub128(rb, back));
      set_balance(snd, sl, add128(balance(snd, sl), back));
      emit("ft_transfer", who, rl, back, snd, sl);
    }
    unused = back;
  }
  u128 kept = sub128(amount, unused);
  on = 0; PUT("\""); put_u128(kept); PUT("\""); value_return(on, PTR(out));
}

/* redeem({"amount","quantus_to"}) with exactly 1 yoctoNEAR: burns the caller's tokens and records the
 * 32-byte Quantus account (64 lowercase hex characters) the attesters release the QTC to. */
EXPORT(redeem) void redeem(void) {
  input(0); size_t n = read_reg(0, in, 1024); load_ids(); load_config(); one_yocto();
  parse_json(in, n, "amount quantus_to");
  u128 amount = json_u128("amount", 1, 0);
  const field *f = get_field("quantus_to");
  REQUIRE(f && f->vl == 64, "quantus_to is a 32-byte account id in lowercase hex");
  burn_to_quantus(amount, f->v);
}

EXPORT(ft_balance_of) void ft_balance_of(void) {
  input(0); size_t n = read_reg(0, in, 1024);
  parse_json(in, n, "account_id");
  size_t al = json_id("account_id", who);
  on = 0; PUT("\""); put_u128(balance(who, al)); PUT("\""); value_return(on, PTR(out));
}
EXPORT(ft_total_supply) void ft_total_supply(void) { on = 0; PUT("\""); put_u128(supply()); PUT("\""); value_return(on, PTR(out)); }
EXPORT(ft_metadata) void ft_metadata(void) {
  on = 0;
  PUT("{\"spec\":\"ft-1.0.0\",\"name\":\"QTC via Qlyphs PQ bridge (" QP_CHAIN ")\",\"symbol\":\"pqQTC\",\"icon\":null,\"reference\":null,\"reference_hash\":null,\"decimals\":12}");
  value_return(on, PTR(out));
}

/* state(): the Quantus genesis, SHA-256 of each attester key, supply and counters. */
EXPORT(state) void state(void) {
  load_config();
  on = 0; PUT("{\"context\":\"" CONTEXT "\",\"network\":\"" QP_CHAIN "\",\"quantus_genesis\":\""); put_hex(cfg, 32);
  PUT("\",\"attesters\":[");
  for (unsigned k = 0; k < 3; k++) {
    uint8_t h[32]; sha256(PQ87_PK, PTR(cfg + 32 + k * PQ87_PK), 0); REQUIRE(read_reg(0, h, 32) == 32, "sha256");
    if (k) PUT(","); PUT("\""); put_hex(h, 32); PUT("\"");
  }
  PUT("],\"threshold\":2,\"supply\":\""); put_u128(supply());
  PUT("\",\"receipts\":"); put_u64(rd_u64_key("n"));
  PUT(",\"redemptions\":"); put_u64(rd_u64_key("m")); PUT("}");
  value_return(on, PTR(out));
}

/* deposit({"deposit_id"}): whether a Quantus deposit id (64 hex) has been minted. */
EXPORT(deposit) void deposit(void) {
  input(0); size_t n = read_reg(0, in, 1024);
  parse_json(in, n, "deposit_id");
  const field *f = get_field("deposit_id");
  REQUIRE(f && f->vl == 64, "deposit_id is 64 lowercase hex characters");
  uint8_t dk[33]; dk[0] = 'd';
  for (unsigned k = 0; k < 32; k++) { int a = unhex(f->v[2 * k]), b = unhex(f->v[2 * k + 1]); REQUIRE(a >= 0 && b >= 0, "deposit_id is lowercase hex"); dk[1 + k] = (uint8_t)(a << 4 | b); }
  on = 0; PUT(storage_read(33, PTR(dk), 0) == 1 ? "true" : "false"); value_return(on, PTR(out));
}

/* receipts({"from","limit"}): up to 8 encrypted receipts in order, as hex strings. Everyone reads the same pages. */
EXPORT(receipts) void receipts(void) {
  input(0); size_t n = read_reg(0, in, 1024);
  parse_json(in, n, "from limit");
  u128 from = json_u128("from", 1, 0), lim = json_u128("limit", 1, 0);
  REQUIRE(from.hi == 0 && lim.hi == 0 && lim.lo >= 1 && lim.lo <= MAX_PAGE, "limit is 1 to 8");
  uint64_t total = rd_u64_key("n");
  on = 0; PUT("[");
  for (uint64_t r = from.lo, c = 0; r < total && c < lim.lo; r++, c++) {
    uint8_t rk[9]; rk[0] = 'r'; put64(rk + 1, r);
    REQUIRE(storage_read(9, PTR(rk), 0) == 1, "missing receipt");
    size_t l = read_reg(0, in, MAX_RECEIPT);
    if (c) PUT(","); PUT("\""); put_hex(in, l); PUT("\"");
  }
  PUT("]"); value_return(on, PTR(out));
}

/* redemption({"id"}): one redemption record, or null. */
EXPORT(redemption) void redemption(void) {
  input(0); size_t n = read_reg(0, in, 1024);
  parse_json(in, n, "id");
  u128 id = json_u128("id", 1, 0);
  REQUIRE(id.hi == 0, "bad id");
  uint8_t xk[9]; xk[0] = 'x'; put64(xk + 1, id.lo);
  on = 0;
  if (storage_read(9, PTR(xk), 0) != 1) { PUT("null"); value_return(on, PTR(out)); return; }
  uint8_t rec[57 + MAX_ID]; size_t l = read_reg(0, rec, sizeof(rec));
  REQUIRE(l >= 57 && l == 57u + rec[56], "bad redemption record");
  PUT("{\"amount\":\""); put_u128(rd128(rec)); PUT("\",\"quantus_to\":\""); put_hex(rec + 16, 32);
  PUT("\",\"block\":"); put_u64(le64(rec + 48)); PUT(",\"account\":\""); put_bytes(rec + 57, rec[56]); PUT("\"}");
  value_return(on, PTR(out));
}
