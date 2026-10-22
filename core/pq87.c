/* Research implementation of Pure ML-DSA-87 verification, FIPS 204.
 * NTT ordering and rounding follow pq-crystals/dilithium ref at
 * d35ba3fe5449bee3e6d43e1f296c3ca818bd36be (see THIRD_PARTY.md).
 * No signature-generation code, no server assertions, no OpenSSL dependency.
 * Fixed-size, bounded state; one row per incremental call. Not audited.
 * Assumes little-endian, two's-complement arithmetic with arithmetic right shift
 * as provided by the supported x86_64/SBF targets. Host UBSan is a release gate. */
#include "pq87.h"
#include "memory.h"
#define Q 8380417
#define GAMMA1 (1<<19)
#define GAMMA2 ((Q-1)/32)
#define BETA 120
#define TAU 60
#define OMEGA 75
#define HOFF (64+7*640)
#if defined(__GNUC__)
#define NOINLINE __attribute__((noinline))
#else
#define NOINLINE
#endif
static const int32_t zetas[256]={
#include "zetas.inc"
};
#define ROL64(a,n) (((a)<<(n))|((a)>>(64-(n))))
#include "keccak_round.inc"
/* Keccak-f[1600] as 12 pairs of fused, unrolled rounds bouncing between a and e. */
static NOINLINE void keccak(uint64_t a[25]) {
  static const uint64_t rc[24]={
    0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
    0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
    0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
    0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
    0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
    0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL};
  uint64_t e[25];
  for(unsigned r=0;r<24;r+=2){KECCAK_ROUND(a,e,rc[r]);KECCAK_ROUND(e,a,rc[r+1]);}
}
static void xinit(pq87_xof *s,unsigned rate){memset(s,0,sizeof(*s));s->rate=rate;}
static uint64_t le64(const uint8_t *p){
  return (uint64_t)p[0]|(uint64_t)p[1]<<8|(uint64_t)p[2]<<16|(uint64_t)p[3]<<24|
         (uint64_t)p[4]<<32|(uint64_t)p[5]<<40|(uint64_t)p[6]<<48|(uint64_t)p[7]<<56;
}
/* Whole lanes when the position is lane-aligned (rates 136 and 168 are multiples of 8),
 * single bytes otherwise. Same sponge input as a byte-by-byte absorb. */
static void absorb(pq87_xof *s,const uint8_t *p,size_t n){
  while(n){
    if(s->pos%8==0&&n>=8){s->a[s->pos/8]^=le64(p);s->pos+=8;p+=8;n-=8;}
    else{s->a[s->pos/8]^=(uint64_t)*p<<((s->pos%8)*8);s->pos++;p++;n--;}
    if(s->pos==s->rate){keccak(s->a);s->pos=0;}
  }
}
static void finalize(pq87_xof *s){
  s->a[s->pos/8]^=0x1fULL<<((s->pos%8)*8);s->a[(s->rate-1)/8]^=0x80ULL<<(((s->rate-1)%8)*8);
  keccak(s->a);s->pos=0;s->squeezing=1;
}
static void squeeze(pq87_xof *s,uint8_t *p,size_t n){
  for(size_t i=0;i<n;i++){if(s->pos==s->rate){keccak(s->a);s->pos=0;}p[i]=(uint8_t)(s->a[s->pos/8]>>((s->pos%8)*8));s->pos++;}
}
void pq87_shake256(uint8_t *out,size_t n,const uint8_t *in,size_t len){pq87_xof s;xinit(&s,136);absorb(&s,in,len);finalize(&s);squeeze(&s,out,n);}
static int32_t mont(int64_t a){
  /* Unsigned multiplication avoids signed-overflow UB in the low word. */
  uint32_t lo=(uint32_t)a*58728449u;
  int64_t t=lo<=INT32_MAX?(int64_t)lo:(int64_t)lo-4294967296LL;
  return (int32_t)((a-t*Q)>>32);
}
static int32_t reduce32(int32_t a){int32_t t=(a+(1<<22))>>23;return a-t*Q;}
static int32_t caddq(int32_t a){return a+((a>>31)&Q);}
static NOINLINE void ntt(int32_t a[256]){
  unsigned k=0;
  for(unsigned len=128;len;len>>=1)for(unsigned start=0;start<256;start+=2*len){
    int32_t z=zetas[++k];for(unsigned j=start;j<start+len;j++){int32_t t=mont((int64_t)z*a[j+len]);a[j+len]=a[j]-t;a[j]+=t;}
  }
}
static NOINLINE void invntt(int32_t a[256]){
  unsigned k=256;
  for(unsigned len=1;len<256;len<<=1)for(unsigned start=0;start<256;start+=2*len){
    int32_t z=-zetas[--k];for(unsigned j=start;j<start+len;j++){int32_t t=a[j];a[j]=t+a[j+len];a[j+len]=mont((int64_t)z*(t-a[j+len]));}
  }
  for(unsigned j=0;j<256;j++)a[j]=mont((int64_t)41978*a[j]);
}
/* Canonical packed decoding, byte loads only (no alignment or end over-read).
 * Two 20-bit z coefficients occupy five bytes. Four t1 coefficients occupy five.
 * A host test checks this decoder against an independent bit-by-bit reference. */
void pq87_unpack_z(const uint8_t p[640],int32_t out[256]) {
  for(unsigned i=0;i<128;i++) {
    const uint8_t *b=p+5*i;
    uint32_t a=(uint32_t)b[0]|((uint32_t)b[1]<<8)|((uint32_t)(b[2]&15)<<16);
    uint32_t c=((uint32_t)b[2]>>4)|((uint32_t)b[3]<<4)|((uint32_t)b[4]<<12);
    out[2*i]=GAMMA1-(int32_t)a;out[2*i+1]=GAMMA1-(int32_t)c;
  }
}
static void unpack_t1(const uint8_t p[320],int32_t out[256]) {
  for(unsigned i=0;i<64;i++) {
    const uint8_t *b=p+5*i;
    out[4*i]=(int32_t)(((uint32_t)b[0]|((uint32_t)(b[1]&3)<<8))<<13);
    out[4*i+1]=(int32_t)((((uint32_t)b[1]>>2)|((uint32_t)(b[2]&15)<<6))<<13);
    out[4*i+2]=(int32_t)((((uint32_t)b[2]>>4)|((uint32_t)(b[3]&63)<<4))<<13);
    out[4*i+3]=(int32_t)((((uint32_t)b[3]>>6)|((uint32_t)b[4]<<2))<<13);
  }
}
/* RejNTTPoly (FIPS 204): 3-byte candidates read straight from each 168-byte SHAKE128
 * block. 168 = 56 * 3, so no candidate straddles two blocks. */
static NOINLINE int expand(int32_t a[256],const uint8_t rho[32],unsigned row,unsigned col){
  pq87_xof s;uint8_t nonce[2]={(uint8_t)col,(uint8_t)row};unsigned k=0;
  xinit(&s,168);absorb(&s,rho,32);absorb(&s,nonce,2);finalize(&s);
  /* Explicit fail-closed resource cap, far beyond normal rejection sampling: at most
   * 4096 candidates, exactly as before. If exceeded, this PoC rejects even a valid
   * signature. The byte order of the lanes is little-endian on every supported target. */
  for(unsigned c=0;;){
    const uint8_t *b=(const uint8_t*)s.a;
    for(unsigned i=0;i<168&&k<256&&c<4096;i+=3,c++){
      uint32_t x=((uint32_t)b[i]|((uint32_t)b[i+1]<<8)|((uint32_t)b[i+2]<<16))&0x7fffff;
      if(x<Q)a[k++]=(int32_t)x;
    }
    if(k==256)return 0;
    if(c>=4096)return -1;
    keccak(s.a);
  }
}
static NOINLINE int challenge(int32_t c[256],const uint8_t seed[64]){
  pq87_xof s;uint8_t b[8];uint64_t signs=0;unsigned draws=0;
  xinit(&s,136);absorb(&s,seed,64);finalize(&s);squeeze(&s,b,8);
  for(unsigned i=0;i<8;i++)signs|=(uint64_t)b[i]<<(8*i);memset(c,0,256*sizeof(*c));
  for(unsigned i=256-TAU;i<256;i++){
    do{if(++draws>4096)return -1;squeeze(&s,b,1);}while(b[0]>i);
    c[i]=c[b[0]];c[b[0]]=1-2*(int32_t)(signs&1);signs>>=1;
  }return 0;
}
static int hints_valid(const uint8_t *h){
  unsigned prev=0;
  for(unsigned r=0;r<8;r++){unsigned end=h[OMEGA+r];if(end<prev||end>OMEGA)return 0;
    for(unsigned j=prev+1;j<end;j++)if(h[j]<=h[j-1])return 0;prev=end;}
  for(unsigned j=prev;j<OMEGA;j++)if(h[j]!=0)return 0;return 1;
}
static int32_t highbits(int32_t a,unsigned hint){
  int32_t a1=(a+127)>>7;a1=(a1*1025+(1<<21))>>22;a1&=15;
  int32_t a0=a-a1*2*GAMMA2;a0-=(((Q-1)/2-a0)>>31)&Q;
  return !hint?a1:(a0>0?(a1+1)&15:(a1-1)&15);
}
size_t pq87_state_size(void){return sizeof(pq87_state);}
int pq87_begin(pq87_state *s,const uint8_t *pk,size_t pklen,const uint8_t *sig,size_t siglen,
              const uint8_t *msg,size_t mlen,const uint8_t *ctx,size_t ctxlen){
  if(!s)return -1;memset(s,0,sizeof(*s));s->status=3;
  if(!pk||!sig||pklen!=PQ87_PK||siglen!=PQ87_SIG||mlen>PQ87_MAX_MESSAGE||ctxlen>255||(!msg&&mlen)||(!ctx&&ctxlen))return -1;
  if(!hints_valid(sig+HOFF))return -1;
  if(challenge(s->challenge,sig))return -1;ntt(s->challenge);
  uint8_t mu[64],prefix[2]={0,(uint8_t)ctxlen};pq87_shake256(mu,64,pk,pklen);
  pq87_xof hash;xinit(&hash,136);absorb(&hash,mu,64);absorb(&hash,prefix,2);absorb(&hash,ctx,ctxlen);absorb(&hash,msg,mlen);finalize(&hash);squeeze(&hash,mu,64);
  xinit(&s->transcript,136);absorb(&s->transcript,mu,64);s->row=0;s->prepared=0;s->status=4;return 0;
}
NOINLINE int pq87_prepare_z(pq87_state *s,const uint8_t sig[PQ87_SIG]){
  if(!s||!sig||s->status!=4||s->prepared>=PQ87_L)return -1;
  unsigned l=s->prepared;pq87_unpack_z(sig+64+l*640,s->z[l]);
  for(unsigned i=0;i<256;i++){
    int32_t z=s->z[l][i];if(z>=GAMMA1-BETA||z<=-(GAMMA1-BETA)){s->status=3;return -1;}
  }
  ntt(s->z[l]);s->prepared++;
  if(s->prepared==PQ87_L){s->status=1;return 1;}return 0;
}
/* Host/reference convenience only. SBF calls begin, then prepare_z separately. */
#ifndef QLYP_SBF
int pq87_init(pq87_state *s,const uint8_t *pk,size_t pklen,const uint8_t *sig,size_t siglen,
              const uint8_t *msg,size_t mlen,const uint8_t *ctx,size_t ctxlen){
  if(pq87_begin(s,pk,pklen,sig,siglen,msg,mlen,ctx,ctxlen))return -1;
  for(unsigned l=0;l<PQ87_L;l++)if(pq87_prepare_z(s,sig)<0)return -1;
  return 0;
}
#endif
/* Per-call stack stays under the 4096-byte SBF frame: two polynomials and a
 * 128-byte packed row. expand()/ntt()/invntt() are out-of-line. */
NOINLINE int pq87_step(pq87_state *s,const uint8_t pk[PQ87_PK],const uint8_t sig[PQ87_SIG]){
  if(!s||!pk||!sig||s->status!=1||s->row>=8||s->prepared!=PQ87_L)return -1;
  int32_t a[256],w[256];uint8_t packed[128];memset(w,0,sizeof(w));unsigned r=s->row;
  for(unsigned l=0;l<7;l++){
    if(expand(a,pk,r,l)){s->status=3;return -1;}
    for(unsigned i=0;i<256;i++)w[i]+=mont((int64_t)a[i]*s->z[l][i]);
  }
  unpack_t1(pk+32+r*320,a);
  ntt(a);
  for(unsigned i=0;i<256;i++)w[i]=reduce32(w[i]-mont((int64_t)s->challenge[i]*a[i]));
  invntt(w);
  const uint8_t *h=sig+HOFF;unsigned pos=r?h[OMEGA+r-1]:0,end=h[OMEGA+r];
  memset(packed,0,sizeof(packed));
  for(unsigned i=0;i<256;i++){
    unsigned hint=(pos<end && h[pos]==i);pos+=hint;
    uint8_t v=(uint8_t)highbits(caddq(w[i]),hint);packed[i/2]|=(uint8_t)(v<<((i%2)*4));
  }
  absorb(&s->transcript,packed,sizeof(packed));s->row++;
  if(s->row==8){uint8_t c[64];unsigned diff=0;finalize(&s->transcript);squeeze(&s->transcript,c,64);
    for(unsigned i=0;i<64;i++)diff|=c[i]^sig[i];s->status=diff?3:2;return diff?-1:1;
  }return 0;
}
/* Host convenience. SBF entrypoint never allocates this object on its stack. */
#ifndef QLYP_SBF
int pq87_verify(const uint8_t *pk,size_t pklen,const uint8_t *sig,size_t siglen,const uint8_t *msg,size_t mlen,const uint8_t *ctx,size_t ctxlen){
  pq87_state s;if(pq87_init(&s,pk,pklen,sig,siglen,msg,mlen,ctx,ctxlen))return -1;
  for(unsigned r=0;r<8;r++)if(pq87_step(&s,pk,sig)<0)return -1;return s.status==2?0:-1;
}
#endif
#ifdef QP_BENCH
/* Profiling build only (never in a release binary): run one primitive so a
 * simulated transaction reports its compute units in isolation. */
uint64_t pq87_bench(unsigned op){
  uint64_t a[25];int32_t p[256];uint8_t rho[32],out[64],in[2592];
  for(unsigned i=0;i<25;i++)a[i]=i*0x9e3779b97f4a7c15ULL;
  for(unsigned i=0;i<256;i++)p[i]=(int32_t)(i*7919u%Q);
  for(unsigned i=0;i<32;i++)rho[i]=(uint8_t)i;
  switch(op){
    case 0:break;
    case 1:keccak(a);return a[3]==1;
    case 2:if(expand(p,rho,0,0))return 1;return p[5]==1;
    case 3:ntt(p);return p[5]==1;
    case 4:invntt(p);return p[5]==1;
    case 5:for(unsigned i=0;i<sizeof(in);i++)in[i]=(uint8_t)i;pq87_shake256(out,64,in,sizeof(in));return out[0]==1;
    case 6:for(unsigned r=0;r<10;r++)keccak(a);return a[3]==1;
  }
  return 0;
}
#endif
