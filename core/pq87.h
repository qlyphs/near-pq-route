#ifndef QLYP_PQ87_H
#define QLYP_PQ87_H
#include <stdint.h>
#include <stddef.h>
#define PQ87_PK 2592u
#define PQ87_SIG 4627u
#define PQ87_N 256u
#define PQ87_K 8u
#define PQ87_L 7u
#define PQ87_MAX_MESSAGE 4096u
/* Pure ML-DSA-87, FIPS 204, standard SHAKE. Verification only.
 * All intermediate state must be trusted program-owned memory. These functions
 * do NOT authenticate a client-supplied state or a Solana account. */
typedef struct { uint64_t a[25]; uint32_t pos, rate, squeezing; } pq87_xof;
typedef struct {
  int32_t z[PQ87_L][PQ87_N];
  int32_t challenge[PQ87_N];
  pq87_xof transcript;
  uint32_t row, status, prepared; /* 0 empty, 1 rows, 2 valid, 3 invalid, 4 preparing z */
} pq87_state;
size_t pq87_state_size(void);
void pq87_shake256(uint8_t *out,size_t n,const uint8_t *in,size_t len);
int pq87_begin(pq87_state *s,const uint8_t *pk,size_t pklen,
              const uint8_t *sig,size_t siglen,const uint8_t *msg,size_t mlen,
              const uint8_t *ctx,size_t ctxlen);
/* One fixed 640-byte z polynomial and one NTT. sig must stay immutable. */
int pq87_prepare_z(pq87_state *s,const uint8_t sig[PQ87_SIG]);
int pq87_init(pq87_state *s,const uint8_t *pk,size_t pklen,
              const uint8_t *sig,size_t siglen,const uint8_t *msg,size_t mlen,
              const uint8_t *ctx,size_t ctxlen);
/* One deterministic row of Az-c*t1, then the final challenge comparison on row 8.
 * pk and sig MUST be the same immutable bytes used by init. */
int pq87_step(pq87_state *s,const uint8_t pk[PQ87_PK],const uint8_t sig[PQ87_SIG]);
int pq87_verify(const uint8_t *pk,size_t pklen,const uint8_t *sig,size_t siglen,
                const uint8_t *msg,size_t mlen,const uint8_t *ctx,size_t ctxlen);
#ifdef QP_BENCH
uint64_t pq87_bench(unsigned op);
#endif
#endif
