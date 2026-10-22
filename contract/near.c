/* NEAR gas-measurement contract for the ML-DSA-87 verifier in core/ (spike, not a vault).
 * Raw Wasm against the NEAR host ABI, so the verifier bytes are the same C as on Solana.
 * Input of verify / verify_profile: pk(2592) | sig(4627) | ctxlen(1) | ctx | msg. */
#include <stdint.h>
#include <stddef.h>
#include "../core/pq87.h"

#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))
IMPORT(input) void input(uint64_t reg);
IMPORT(register_len) uint64_t register_len(uint64_t reg);
IMPORT(read_register) void read_register(uint64_t reg, uint64_t ptr);
IMPORT(value_return) void value_return(uint64_t len, uint64_t ptr);
IMPORT(log_utf8) void log_utf8(uint64_t len, uint64_t ptr);
IMPORT(panic_utf8) void panic_utf8(uint64_t len, uint64_t ptr);
IMPORT(used_gas) uint64_t used_gas(void);

#define MAX_INPUT (PQ87_PK + PQ87_SIG + 1 + 255 + PQ87_MAX_MESSAGE)
static uint8_t in[MAX_INPUT];
static pq87_state st; /* static, not on the stack: about 8 KiB */

static void fail(const char *m) { size_t n = 0; while (m[n]) n++; panic_utf8(n, (uint64_t)(uintptr_t)m); }

static size_t read_input(void) {
  input(0);
  uint64_t n = register_len(0);
  if (n == UINT64_MAX || n > MAX_INPUT) fail("input too large");
  read_register(0, (uint64_t)(uintptr_t)in);
  return (size_t)n;
}

/* Logs "<label> <gas>" so each stage's cumulative gas shows in the receipt logs. */
static void log_gas(const char *label, unsigned idx) {
  char b[64]; size_t n = 0;
  while (label[n]) { b[n] = label[n]; n++; }
  if (idx < 10) b[n++] = (char)('0' + idx);
  b[n++] = ' ';
  uint64_t g = used_gas(); char d[20]; unsigned k = 0;
  do { d[k++] = (char)('0' + g % 10); g /= 10; } while (g);
  while (k) b[n++] = d[--k];
  log_utf8(n, (uint64_t)(uintptr_t)b);
}

typedef struct { const uint8_t *pk, *sig, *ctx, *msg; size_t ctxlen, mlen; } parsed;

static parsed parse(size_t n) {
  parsed p;
  if (n < PQ87_PK + PQ87_SIG + 1) fail("input too short");
  p.pk = in; p.sig = in + PQ87_PK; p.ctxlen = in[PQ87_PK + PQ87_SIG];
  if (n < PQ87_PK + PQ87_SIG + 1 + p.ctxlen) fail("bad context length");
  p.ctx = in + PQ87_PK + PQ87_SIG + 1; p.msg = p.ctx + p.ctxlen;
  p.mlen = n - (PQ87_PK + PQ87_SIG + 1 + p.ctxlen);
  return p;
}

static void ret(int ok) { uint8_t r = ok ? '1' : '0'; value_return(1, (uint64_t)(uintptr_t)&r); }

/* One call, whole verification. Returns "1" for a valid signature, "0" otherwise. */
EXPORT(verify) void verify(void) {
  parsed p = parse(read_input());
  log_gas("start", 99);
  int ok = pq87_verify(p.pk, PQ87_PK, p.sig, PQ87_SIG, p.msg, p.mlen, p.ctx, p.ctxlen) == 0;
  log_gas("verified", 99);
  ret(ok);
}

/* Same verification with a gas reading after every stage, for the cost breakdown. */
EXPORT(verify_profile) void verify_profile(void) {
  parsed p = parse(read_input());
  log_gas("start", 99);
  if (pq87_begin(&st, p.pk, PQ87_PK, p.sig, PQ87_SIG, p.msg, p.mlen, p.ctx, p.ctxlen)) { ret(0); return; }
  log_gas("begin", 99);
  for (unsigned l = 0; l < PQ87_L; l++) { if (pq87_prepare_z(&st, p.sig) < 0) { ret(0); return; } log_gas("z", l); }
  int r = 0;
  for (unsigned row = 0; row < PQ87_K; row++) { r = pq87_step(&st, p.pk, p.sig); log_gas("row", row); if (r < 0) break; }
  ret(r == 1 && st.status == 2);
}

/* Input: one byte, the pq87_bench op (0 baseline, 1 keccak, 2 expand, 3 ntt, 4 invntt, 5 shake 2592 B). */
EXPORT(bench) void bench(void) {
  if (read_input() != 1) fail("one op byte");
  log_gas("before", 99);
  volatile uint64_t r = pq87_bench(in[0]); (void)r;
  log_gas("after", 99);
}
