/* Reference target for Qlyphs Guardian: a small fungible token (NEP-141 subset) whose admin powers,
 * minting and code upgrades, start with a classical owner and can be handed over, once and for good, to a
 * Guardian contract. Built twice: -DTOKEN_VERSION=1 and 2; V2 differs only in its metadata and version.
 * Protocol: docs/GUARDIAN.md. Raw Wasm against the NEAR host ABI, like the vault. */
#include <stdint.h>
#include <stddef.h>
#include "../core/memory.h"
#ifndef TOKEN_VERSION
#error "build with -DTOKEN_VERSION=1 or 2"
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
IMPORT(attached_deposit) void attached_deposit(uint64_t ptr);
IMPORT(promise_batch_create) uint64_t promise_batch_create(uint64_t len, uint64_t ptr);
IMPORT(promise_batch_action_deploy_contract) void promise_batch_action_deploy_contract(uint64_t idx, uint64_t len, uint64_t ptr);
IMPORT(promise_batch_action_function_call) void promise_batch_action_function_call(
  uint64_t idx, uint64_t mlen, uint64_t mptr, uint64_t alen, uint64_t aptr, uint64_t amount_ptr, uint64_t gas);
IMPORT(promise_return) void promise_return(uint64_t idx);

#define MAX_ID 64u
#define MAX_CODE 131072u
#define TGAS 1000000000000ULL
#define MIGRATE_GAS (20 * TGAS)

/* Storage keys: "v" version (u32), "o" owner id (legacy mode only), "g" Guardian id (guarded mode only),
 * "l" next acceptable Guardian operation id (u64, absent = 0), "s" total supply (u128), "b<account>" balance (u128). */
static uint8_t in[16 + MAX_CODE];
static uint8_t self_id[MAX_ID], caller[MAX_ID], who[MAX_ID], key[1 + MAX_ID];
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
static size_t read_input(size_t cap) { input(0); return read_reg(0, in, cap); }
static void load_ids(void) {
  current_account_id(0); self_len = read_reg(0, self_id, MAX_ID);
  predecessor_account_id(0); caller_len = read_reg(0, caller, MAX_ID);
}
static int same(const uint8_t *a, size_t an, const uint8_t *b, size_t bn) { return an == bn && memcmp(a, b, an) == 0; }
static uint64_t le64(const uint8_t *p) { uint64_t x = 0; for (unsigned i = 0; i < 8; i++) x |= (uint64_t)p[i] << (8 * i); return x; }
static void put64(uint8_t *p, uint64_t x) { for (unsigned i = 0; i < 8; i++) p[i] = (uint8_t)(x >> (8 * i)); }
static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

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
  REQUIRE(a.hi < (1ULL << 60), "amount overflow");
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

/* Minimal JSON input: a flat object of string values, no escapes. Finds "name":"value" and returns the
 * value's span; a name present twice is refused. Values here are account ids or decimal digits, which
 * contain no quote, so the pattern cannot match inside a value. */
static const uint8_t *json_str(const uint8_t *j, size_t n, const char *name, size_t *vlen) {
  char pat[24]; size_t p = 0; pat[p++] = '"';
  for (const char *s = name; *s; s++) pat[p++] = *s;
  pat[p++] = '"'; pat[p++] = ':'; pat[p++] = '"';
  const uint8_t *found = 0;
  for (size_t i = 0; i + p <= n; i++) {
    if (memcmp(j + i, pat, p) != 0) continue;
    REQUIRE(!found, "duplicate JSON field");
    found = j + i + p;
  }
  if (!found) return 0;
  size_t k = 0;
  while (found + k < j + n && found[k] != '"') { REQUIRE(found[k] != '\\', "escapes not supported"); k++; }
  REQUIRE(found + k < j + n, "unterminated JSON string");
  *vlen = k;
  return found;
}
static size_t json_id(const uint8_t *j, size_t n, const char *name, uint8_t *out) {
  size_t len; const uint8_t *v = json_str(j, n, name, &len);
  REQUIRE(v && valid_id(v, len), "missing or invalid account id");
  memcpy(out, v, len);
  return len;
}
static u128 json_u128(const uint8_t *j, size_t n, const char *name, int required, int *present) {
  size_t len; const uint8_t *v = json_str(j, n, name, &len);
  u128 x = { 0, 0 };
  if (present) *present = v != 0;
  if (!v) { REQUIRE(!required, "missing number"); return x; }
  REQUIRE(len >= 1 && len <= 39 && (len == 1 || v[0] != '0'), "bad number");
  for (size_t i = 0; i < len; i++) { REQUIRE(v[i] >= '0' && v[i] <= '9', "bad number"); x = mul10add(x, v[i] - '0'); }
  return x;
}

static int has(const char *k) { return storage_read(1, PTR(k), 0) == 1; }
static size_t read_id_key(const char *k, uint8_t *out) {
  if (storage_read(1, PTR(k), 0) != 1) return 0;
  return read_reg(0, out, MAX_ID);
}
static uint32_t version(void) { uint8_t v[4]; REQUIRE(storage_read(1, PTR("v"), 0) == 1 && read_reg(0, v, 4) == 4, "not initialized"); return le32(v); }
static uint64_t next_op(void) { uint8_t l[8]; if (storage_read(1, PTR("l"), 0) != 1) return 0; REQUIRE(read_reg(0, l, 8) == 8, "bad op"); return le64(l); }
/* Records op as applied: the next acceptable id becomes op + 1. Ids may skip, never repeat. */
static void apply_op(uint64_t op) { REQUIRE(op != UINT64_MAX, "operation id exhausted"); uint8_t l[8]; put64(l, op + 1); storage_write(1, PTR("l"), 8, PTR(l), 0); }

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
static u128 supply(void) { uint8_t b[16]; u128 z = { 0, 0 }; if (storage_read(1, PTR("s"), 0) != 1) return z; REQUIRE(read_reg(0, b, 16) == 16, "bad supply"); return rd128(b); }
static void set_supply(u128 x) { uint8_t b[16]; wr128(b, x); storage_write(1, PTR("s"), 16, PTR(b), 0); }

static char out[512]; static size_t on;
#define PUT(s) do { const char *s_ = (s); while (*s_) out[on++] = *s_++; } while (0)
static void put_bytes(const uint8_t *p, size_t n) { memcpy(out + on, p, n); on += n; }
static void put_u128(u128 x) { char d[40]; size_t n = dec128(x, d); memcpy(out + on, d, n); on += n; }
static void put_u64(uint64_t x) { u128 y = { x, 0 }; put_u128(y); }

static void emit(const char *event, const uint8_t *owner, size_t olen, u128 amount, const uint8_t *to, size_t tlen) {
  on = 0;
  PUT("EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\""); PUT(event); PUT("\",\"data\":[{");
  if (to) { PUT("\"old_owner_id\":\""); put_bytes(owner, olen); PUT("\",\"new_owner_id\":\""); put_bytes(to, tlen); }
  else { PUT("\"owner_id\":\""); put_bytes(owner, olen); }
  PUT("\",\"amount\":\""); put_u128(amount); PUT("\"}]}");
  log_utf8(on, PTR(out));
}

/* new({"owner_id":..}): once, by the token account itself (its deployer). Starts in legacy mode. */
EXPORT(new) void new_(void) {
  size_t n = read_input(1024); load_ids();
  REQUIRE(same(caller, caller_len, self_id, self_len), "only the token account can initialize it");
  REQUIRE(!has("v"), "already initialized");
  size_t ol = json_id(in, n, "owner_id", who);
  storage_write(1, PTR("o"), ol, PTR(who), 0);
  uint8_t v[4] = { TOKEN_VERSION, 0, 0, 0 };
  storage_write(1, PTR("v"), 4, PTR(v), 0);
  u128 z = { 0, 0 }; set_supply(z);
}

/* Admin check: legacy mode, the immediate caller is the owner; guarded mode, it is the Guardian.
 * Returns 1 in guarded mode. The transaction signer never matters, only the immediate caller. */
static int require_admin(void) {
  uint8_t id[MAX_ID]; size_t n;
  if ((n = read_id_key("g", id))) { REQUIRE(same(caller, caller_len, id, n), "only the Guardian can do this"); return 1; }
  REQUIRE((n = read_id_key("o", id)) && same(caller, caller_len, id, n), "only the owner can do this");
  return 0;
}

/* mint({"receiver_id":..,"amount":..,"op_id":..}). From the Guardian, op_id is its operation nonce and
 * must be at least the next acceptable id; it is recorded with the mint, so a replayed call cannot mint twice. */
EXPORT(mint) void mint(void) {
  size_t n = read_input(1024); load_ids(); version();
  int guarded = require_admin(), present;
  u128 op = json_u128(in, n, "op_id", guarded, &present);
  if (guarded) {
    REQUIRE(op.hi == 0 && op.lo >= next_op(), "operation already applied");
    apply_op(op.lo);
  } else REQUIRE(!present, "op_id is for Guardian calls");
  size_t rl = json_id(in, n, "receiver_id", who);
  u128 amount = json_u128(in, n, "amount", 1, 0);
  REQUIRE(!is0(amount), "amount must be positive");
  set_supply(add128(supply(), amount));
  set_balance(who, rl, add128(balance(who, rl), amount));
  emit("ft_mint", who, rl, amount, 0, 0);
}

/* handover({"guardian_id":..}): owner only, once. Removes the owner role for good. */
EXPORT(handover) void handover(void) {
  size_t n = read_input(1024); load_ids(); version();
  REQUIRE(!has("g"), "already guarded");
  require_admin();
  size_t gl = json_id(in, n, "guardian_id", who);
  REQUIRE(!same(who, gl, self_id, self_len), "the token cannot guard itself");
  storage_write(1, PTR("g"), gl, PTR(who), 0);
  storage_remove(1, PTR("o"), 0);
  log_utf8(18, PTR("handed to guardian"));
}

/* upgrade(op_id u64 | from u32 | to u32 | code): Guardian only. One batch receipt to the token itself:
 * deploy the code, then migrate. The receipt's actions are atomic, so a failing migrate keeps the old code
 * and state. Returns that promise so the Guardian sees the real outcome. */
EXPORT(upgrade) void upgrade(void) {
  size_t n = read_input(sizeof(in)); load_ids();
  REQUIRE(has("g"), "upgrades go through the Guardian");
  require_admin();
  REQUIRE(n > 16 && n - 16 <= MAX_CODE, "bad upgrade input");
  uint64_t op = le64(in); uint32_t from = le32(in + 8), to = le32(in + 12);
  REQUIRE(op >= next_op(), "operation already applied");
  REQUIRE(from == version() && to > from, "version mismatch");
  uint8_t none[16] = { 0 };
  uint64_t p = promise_batch_create(self_len, PTR(self_id));
  promise_batch_action_deploy_contract(p, n - 16, PTR(in + 16));
  promise_batch_action_function_call(p, 7, PTR("migrate"), 16, PTR(in), PTR(none), MIGRATE_GAS);
  promise_return(p);
}

/* migrate(op_id u64 | from u32 | to u32): only inside the upgrade batch (the token calling itself).
 * This is the new code's migrate. Balances are untouched; the version and the op id are recorded. */
EXPORT(migrate) void migrate(void) {
  size_t n = read_input(16); load_ids();
  REQUIRE(same(caller, caller_len, self_id, self_len), "private");
  REQUIRE(n == 16, "bad migrate input");
  uint64_t op = le64(in); uint32_t from = le32(in + 8), to = le32(in + 12);
#ifdef FAIL_MIGRATE
  fail("migration refused (test build)");
#endif
  REQUIRE(from == version() && to == TOKEN_VERSION && op >= next_op() && has("g") && !has("o"), "migration does not match this code");
  uint8_t v[4] = { (uint8_t)to, (uint8_t)(to >> 8), (uint8_t)(to >> 16), (uint8_t)(to >> 24) };
  storage_write(1, PTR("v"), 4, PTR(v), 0);
  apply_op(op);
  log_utf8(8, PTR("migrated"));
}

/* ft_transfer({"receiver_id":..,"amount":..,"memo"?}) with exactly 1 yoctoNEAR attached (NEP-141). The receiver
 * must already hold a balance record (created only by mint), so transfers cannot grow the token's storage. */
EXPORT(ft_transfer) void ft_transfer(void) {
  size_t n = read_input(1024); load_ids(); version();
  uint8_t dep[16]; attached_deposit(PTR(dep));
  REQUIRE(le64(dep) == 1 && le64(dep + 8) == 0, "requires attached deposit of exactly 1 yoctoNEAR");
  size_t rl = json_id(in, n, "receiver_id", who);
  REQUIRE(!same(who, rl, caller, caller_len), "sender and receiver are the same");
  key[0] = 'b'; memcpy(key + 1, who, rl);
  REQUIRE(storage_read(1 + rl, PTR(key), 0) == 1, "receiver is not a registered holder");
  u128 amount = json_u128(in, n, "amount", 1, 0);
  REQUIRE(!is0(amount), "amount must be positive");
  set_balance(caller, caller_len, sub128(balance(caller, caller_len), amount));
  set_balance(who, rl, add128(balance(who, rl), amount));
  emit("ft_transfer", caller, caller_len, amount, who, rl);
}

EXPORT(ft_balance_of) void ft_balance_of(void) {
  size_t n = read_input(1024);
  size_t al = json_id(in, n, "account_id", who);
  on = 0; PUT("\""); put_u128(balance(who, al)); PUT("\"");
  value_return(on, PTR(out));
}

EXPORT(ft_total_supply) void ft_total_supply(void) { on = 0; PUT("\""); put_u128(supply()); PUT("\""); value_return(on, PTR(out)); }

EXPORT(ft_metadata) void ft_metadata(void) {
#if TOKEN_VERSION == 1
  static const char m[] = "{\"spec\":\"ft-1.0.0\",\"name\":\"Guardian Demo Token\",\"symbol\":\"GDEMO\",\"decimals\":18}";
#else
  static const char m[] = "{\"spec\":\"ft-1.0.0\",\"name\":\"Guardian Demo Token v2\",\"symbol\":\"GDEMO\",\"decimals\":18}";
#endif
  value_return(sizeof(m) - 1, PTR(m));
}

/* View: {"version":N,"owner":..|null,"guardian":..|null,"next_op":N,"total_supply":".."}. */
EXPORT(state) void state(void) {
  uint8_t id[MAX_ID]; size_t n;
  on = 0; PUT("{\"version\":"); put_u64(version()); PUT(",\"owner\":");
  if ((n = read_id_key("o", id))) { PUT("\""); put_bytes(id, n); PUT("\""); } else PUT("null");
  PUT(",\"guardian\":");
  if ((n = read_id_key("g", id))) { PUT("\""); put_bytes(id, n); PUT("\""); } else PUT("null");
  PUT(",\"next_op\":"); put_u64(next_op()); PUT(",\"total_supply\":\""); put_u128(supply()); PUT("\"}");
  value_return(on, PTR(out));
}
