/* Test-only NEP-141 stand-in: records the caller and arguments of each ft_transfer so the sandbox
 * suite can assert the exact call the vault makes. Not a token. */
#include <stdint.h>
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))
IMPORT(input) void input(uint64_t reg);
IMPORT(register_len) uint64_t register_len(uint64_t reg);
IMPORT(read_register) void read_register(uint64_t reg, uint64_t ptr);
IMPORT(value_return) void value_return(uint64_t len, uint64_t ptr);
IMPORT(panic_utf8) void panic_utf8(uint64_t len, uint64_t ptr);
IMPORT(storage_read) uint64_t storage_read(uint64_t klen, uint64_t kptr, uint64_t reg);
IMPORT(storage_write) uint64_t storage_write(uint64_t klen, uint64_t kptr, uint64_t vlen, uint64_t vptr, uint64_t reg);
IMPORT(predecessor_account_id) void predecessor_account_id(uint64_t reg);
IMPORT(attached_deposit) void attached_deposit(uint64_t ptr);
#define PTR(p) ((uint64_t)(uintptr_t)(p))

static uint8_t rec[1024];

EXPORT(ft_transfer) void ft_transfer(void) {
  uint8_t dep[16]; attached_deposit(PTR(dep));
  unsigned other = 0; for (unsigned i = 1; i < 16; i++) other |= dep[i];
  if (dep[0] != 1 || other) { static const char m[] = "requires exactly 1 yoctoNEAR"; panic_utf8(sizeof(m) - 1, PTR(m)); }
  predecessor_account_id(0); uint64_t p = register_len(0); read_register(0, PTR(rec));
  rec[p] = '|';
  input(1); uint64_t a = register_len(1);
  if (p + 1 + a > sizeof(rec)) { static const char m[] = "arguments too large"; panic_utf8(sizeof(m) - 1, PTR(m)); }
  read_register(1, PTR(rec + p + 1));
  storage_write(4, PTR("last"), p + 1 + a, PTR(rec), 2);
}

EXPORT(last) void last(void) {
  if (storage_read(4, PTR("last"), 0) != 1) { value_return(0, 0); return; }
  uint64_t n = register_len(0); read_register(0, PTR(rec)); value_return(n, PTR(rec));
}
