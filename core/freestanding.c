#include <stddef.h>
void *memcpy(void *d,const void *s,size_t n){unsigned char *x=d;const unsigned char *y=s;for(size_t i=0;i<n;i++)x[i]=y[i];return d;}
void *memset(void *d,int c,size_t n){unsigned char *x=d;for(size_t i=0;i<n;i++)x[i]=(unsigned char)c;return d;}
int memcmp(const void *a,const void *b,size_t n){const unsigned char *x=a,*y=b;for(size_t i=0;i<n;i++)if(x[i]!=y[i])return (int)x[i]-(int)y[i];return 0;}
