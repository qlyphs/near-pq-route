/* NEAR vault factory: the only trusted way to create a vault. Its one batch per vault is fixed code
 * (create, fund, deploy the embedded vault, init), and it records every vault it creates in its own
 * storage, so a wallet can tell its vaults from any account that merely sits under the same name. */
#include <stdint.h>
#include <stddef.h>
#include "../core/memory.h"
#ifndef QP_CHAIN
#error "build with -DQP_CHAIN='\"testnet\"' (or mainnet, sandbox)"
#endif

#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))
IMPORT(input) void input(uint64_t reg);
IMPORT(register_len) uint64_t register_len(uint64_t reg);
IMPORT(read_register) void read_register(uint64_t reg, uint64_t ptr);
IMPORT(value_return) void value_return(uint64_t len, uint64_t ptr);
IMPORT(log_utf8) void log_utf8(uint64_t len, uint64_t ptr);
IMPORT(panic_utf8) void panic_utf8(uint64_t len, uint64_t ptr);
IMPORT(current_account_id) void current_account_id(uint64_t reg);
IMPORT(predecessor_account_id) void predecessor_account_id(uint64_t reg);
IMPORT(attached_deposit) void attached_deposit(uint64_t ptr);
IMPORT(sha256) void sha256(uint64_t len, uint64_t ptr, uint64_t reg);
IMPORT(storage_read) uint64_t storage_read(uint64_t klen, uint64_t kptr, uint64_t reg);
IMPORT(storage_write) uint64_t storage_write(uint64_t klen, uint64_t kptr, uint64_t vlen, uint64_t vptr, uint64_t reg);
IMPORT(storage_remove) uint64_t storage_remove(uint64_t klen, uint64_t kptr, uint64_t reg);
IMPORT(promise_batch_create) uint64_t promise_batch_create(uint64_t len, uint64_t ptr);
IMPORT(promise_batch_action_create_account) void promise_batch_action_create_account(uint64_t idx);
IMPORT(promise_batch_action_transfer) void promise_batch_action_transfer(uint64_t idx, uint64_t amount_ptr);
IMPORT(promise_batch_action_deploy_contract) void promise_batch_action_deploy_contract(uint64_t idx, uint64_t len, uint64_t ptr);
IMPORT(promise_batch_action_function_call) void promise_batch_action_function_call(
  uint64_t idx, uint64_t mlen, uint64_t mptr, uint64_t alen, uint64_t aptr, uint64_t amount_ptr, uint64_t gas);
IMPORT(promise_then) uint64_t promise_then(uint64_t idx, uint64_t alen, uint64_t aptr, uint64_t mlen, uint64_t mptr,
  uint64_t arglen, uint64_t argptr, uint64_t amount_ptr, uint64_t gas);
IMPORT(promise_results_count) uint64_t promise_results_count(void);
IMPORT(promise_result) uint64_t promise_result(uint64_t idx, uint64_t reg);

#define PK 2592u
#define MAX_ID 64u
#define TGAS 1000000000000ULL
/* 0.25 NEAR: covers the vault's storage stake (about 0.19 NEAR) so creation does not fail on funds. */
#define MIN_DEPOSIT_HI 13552ULL /* 0.25 NEAR = hi * 2^64 + lo yoctoNEAR */
#define MIN_DEPOSIT_LO 9724313088156499968ULL
/* 0.01 NEAR of each deposit stays in the factory to pay for the vault's registry record. */
#define FEE_HI 542ULL
#define FEE_LO 1864712049423024128ULL
#define LABEL 16u  /* hex of the first 8 bytes of SHA-256(public key) */
#define PENDING 'P'
#define CREATED 'C'
#define FAILED 'F'  /* creation failed; the deposit is owed to the caller until refund() pays it */
#define REFUNDING 'R'  /* a refund transfer is on its way; on_refund settles it */

static const uint8_t vault_code[] = {
#embed VAULT_WASM
};

static uint8_t pk[PK];
static uint8_t self_id[MAX_ID], who[MAX_ID], vault_id[MAX_ID];
/* Registry record: key "r" + label; value SHA-256(pk) (32) | status | pending, failed or refunding only:
 * deposit (16) | caller len | caller. */
static uint8_t rkey[1 + LABEL], rec[32 + 1 + 16 + 1 + MAX_ID];

static void fail(const char *m) { size_t n = 0; while (m[n]) n++; panic_utf8(n, (uint64_t)(uintptr_t)m); }
#define REQUIRE(c, m) do { if (!(c)) fail(m); } while (0)
#define PTR(p) ((uint64_t)(uintptr_t)(p))

static size_t read_reg(uint64_t reg, uint8_t *out, size_t cap) {
  uint64_t n = register_len(reg);
  REQUIRE(n != UINT64_MAX && n <= cap, "register too large");
  read_register(reg, PTR(out));
  return (size_t)n;
}
static uint64_t le64(const uint8_t *p) { uint64_t x = 0; for (unsigned i = 0; i < 8; i++) x |= (uint64_t)p[i] << (8 * i); return x; }
static void put64(uint8_t *p, uint64_t x) { for (unsigned i = 0; i < 8; i++) p[i] = (uint8_t)(x >> (8 * i)); }

/* create(pk), with at least 0.25 NEAR attached. Creates <label>.<factory>, where the label is derived from
 * the key. The label is a short locator, not the binding: wallets check the full key (checkVault). The record
 * is written before the batch runs; on_create marks it created on success, or failed on failure. */
EXPORT(create) void create(void) {
  input(0);
  REQUIRE(read_reg(0, pk, PK) == PK, "expected a 2592-byte ML-DSA-87 public key");
  uint8_t h[32]; sha256(PK, PTR(pk), 0); REQUIRE(read_reg(0, h, 32) == 32, "sha256");
  static const char hexd[] = "0123456789abcdef";
  rkey[0] = 'r';
  for (unsigned i = 0; i < LABEL / 2; i++) { rkey[1 + 2 * i] = hexd[h[i] >> 4]; rkey[2 + 2 * i] = hexd[h[i] & 15]; }
  REQUIRE(storage_read(sizeof(rkey), PTR(rkey), 0) == 0, "a vault for this key exists or is being created");

  current_account_id(0); size_t slen = read_reg(0, self_id, MAX_ID);
  REQUIRE(LABEL + 1 + slen <= MAX_ID, "factory account id too long");
  memcpy(vault_id, rkey + 1, LABEL); vault_id[LABEL] = '.'; memcpy(vault_id + LABEL + 1, self_id, slen);
  size_t vlen = LABEL + 1 + slen;

  uint8_t dep[16]; attached_deposit(PTR(dep));
  uint64_t lo = le64(dep), hi = le64(dep + 8);
  REQUIRE(hi > MIN_DEPOSIT_HI || (hi == MIN_DEPOSIT_HI && lo >= MIN_DEPOSIT_LO), "attach at least 0.25 NEAR");
  uint8_t fund[16]; put64(fund, lo - FEE_LO); put64(fund + 8, hi - FEE_HI - (lo < FEE_LO));

  predecessor_account_id(0); size_t wlen = read_reg(0, who, MAX_ID);
  memcpy(rec, h, 32); rec[32] = PENDING; memcpy(rec + 33, dep, 16); rec[49] = (uint8_t)wlen; memcpy(rec + 50, who, wlen);
  storage_write(sizeof(rkey), PTR(rkey), 50 + wlen, PTR(rec), 0);

  uint64_t p = promise_batch_create(vlen, PTR(vault_id));
  promise_batch_action_create_account(p);
  promise_batch_action_transfer(p, PTR(fund));
  promise_batch_action_deploy_contract(p, sizeof(vault_code), PTR(vault_code));
  uint8_t none[16] = { 0 };
  promise_batch_action_function_call(p, 4, PTR("init"), PK, PTR(pk), PTR(none), 30 * TGAS);
  promise_then(p, slen, PTR(self_id), 9, PTR("on_create"), sizeof(rkey), PTR(rkey), PTR(none), 10 * TGAS);
}

/* Reads the record at the registry key given as the call's input into rec; returns its length. */
static size_t load_record(void) {
  input(0); REQUIRE(read_reg(0, rkey, sizeof(rkey)) == sizeof(rkey) && rkey[0] == 'r', "bad registry key");
  REQUIRE(storage_read(sizeof(rkey), PTR(rkey), 2) == 1, "no such record");
  return read_reg(2, rec, sizeof(rec));
}

/* Private callback, argument: the registry key. It only rewrites the record's status byte, at the same
 * size or smaller, so it needs no balance and cannot fail on funds. It never pays: the forwarded deposit
 * comes back in a separate refund receipt that may land after this callback, so paying here could fail
 * and leave the record pending for good. */
EXPORT(on_create) void on_create(void) {
  current_account_id(0); size_t slen = read_reg(0, self_id, MAX_ID);
  predecessor_account_id(1); size_t plen = read_reg(1, who, MAX_ID);
  REQUIRE(plen == slen && memcmp(who, self_id, slen) == 0, "private");
  REQUIRE(promise_results_count() == 1, "one result expected");
  size_t n = load_record();
  REQUIRE(n >= 50 && rec[32] == PENDING && n == 50u + rec[49], "no pending creation");
  if (promise_result(0, 3) == 1) {
    rec[32] = CREATED;
    storage_write(sizeof(rkey), PTR(rkey), 33, PTR(rec), 0);
    log_utf8(13, PTR("vault created"));
    return;
  }
  rec[32] = FAILED;
  storage_write(sizeof(rkey), PTR(rkey), n, PTR(rec), 0);
  log_utf8(37, PTR("vault creation failed, refund pending"));
}

/* refund(registry key): anyone may call it. Sends a failed creation's recorded deposit to its recorded
 * caller and marks the record refunding, so no second refund can start meanwhile. The debt is removed only
 * once on_refund sees the transfer succeed: a transfer can fail (the caller's account was deleted) and its
 * amount then comes back to the factory, still owed. If the factory cannot pay yet, the whole call fails
 * and the record stays failed: call again later. */
EXPORT(refund) void refund(void) {
  size_t n = load_record();
  REQUIRE(n >= 50 && rec[32] == FAILED && n == 50u + rec[49], "no failed creation to refund");
  rec[32] = REFUNDING;
  storage_write(sizeof(rkey), PTR(rkey), n, PTR(rec), 0);
  current_account_id(0); size_t slen = read_reg(0, self_id, MAX_ID);
  uint64_t p = promise_batch_create(rec[49], PTR(rec + 50));
  promise_batch_action_transfer(p, PTR(rec + 33));
  uint8_t none[16] = { 0 };
  promise_then(p, slen, PTR(self_id), 9, PTR("on_refund"), sizeof(rkey), PTR(rkey), PTR(none), 10 * TGAS);
}

/* Private callback of refund, argument: the registry key. Only rewrites or removes the record, so it
 * needs no balance. Delivered: the debt is gone. Not delivered: the amount came back and is owed again. */
EXPORT(on_refund) void on_refund(void) {
  current_account_id(0); size_t slen = read_reg(0, self_id, MAX_ID);
  predecessor_account_id(1); size_t plen = read_reg(1, who, MAX_ID);
  REQUIRE(plen == slen && memcmp(who, self_id, slen) == 0, "private");
  REQUIRE(promise_results_count() == 1, "one result expected");
  size_t n = load_record();
  REQUIRE(n >= 50 && rec[32] == REFUNDING && n == 50u + rec[49], "no refund in progress");
  if (promise_result(0, 3) == 1) {
    storage_remove(sizeof(rkey), PTR(rkey), 0);
    log_utf8(8, PTR("refunded"));
    return;
  }
  rec[32] = FAILED;
  storage_write(sizeof(rkey), PTR(rkey), n, PTR(rec), 0);
  log_utf8(32, PTR("refund not delivered, owed again"));
}

/* View: {"version":..,"chain":..,"vault_sha256":"<hex>"}: the vault code this factory deploys. */
EXPORT(state) void state(void) {
  uint8_t h[32]; sha256(sizeof(vault_code), PTR(vault_code), 0); REQUIRE(read_reg(0, h, 32) == 32, "sha256");
  static const char hexd[] = "0123456789abcdef";
  char out[192]; size_t n = 0;
#define PUT(s) do { const char *s_ = (s); while (*s_) out[n++] = *s_++; } while (0)
  PUT("{\"version\":\"qlyphs/near-vault-factory/v1\",\"chain\":\"" QP_CHAIN "\",\"vault_sha256\":\"");
  for (unsigned i = 0; i < 32; i++) { out[n++] = hexd[h[i] >> 4]; out[n++] = hexd[h[i] & 15]; }
  PUT("\"}");
#undef PUT
  value_return(n, PTR(out));
}
