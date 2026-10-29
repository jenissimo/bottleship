/* Owned deterministic IPC peer for the bridge parser's reentrant abort case. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
static void u32(unsigned char *p, uint32_t n) { p[0]=(unsigned char)n; p[1]=(unsigned char)(n>>8); p[2]=(unsigned char)(n>>16); p[3]=(unsigned char)(n>>24); }
static void head(unsigned char *p, uint32_t size, unsigned char op, uint32_t id) {
    memset(p,0,size); u32(p,size); p[4]=1; p[5]=op; u32(p+8,id); u32(p+12,93);
}
int main(void) {
    unsigned char init[36], input[24], out[77];
    head(init,20,101,0); u32(init+16,12345); head(init+20,16,102,0);
    if(fwrite(init,1,sizeof init,stdout)!=sizeof init || fflush(stdout)) return 1;
    if(fread(input,1,sizeof input,stdin)!=sizeof input || input[5]!=1) return 2;
    head(out,44,103,1); u32(out+16,1); memcpy(out+20,input+16,8); out[28]=1;
    out[36]=127;out[39]=1;u32(out+40,40000);
    head(out+44,33,109,0);out[60]=1;memcpy(out+68,input+16,8);out[76]='X';
    if(fwrite(out,1,sizeof out,stdout)!=sizeof out || fflush(stdout)) return 3;
    while(getchar()!=EOF) {}
    return 0;
}
