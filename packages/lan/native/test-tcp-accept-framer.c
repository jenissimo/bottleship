/* Incremental frame parsing and short output writes against a real actor. */
#ifdef _WIN32
#include <winsock2.h>
#else
#include <arpa/inet.h>
#endif
#include "tcp-accept-framer.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_actor *a=calloc(1,sizeof(*a));assert(a);
    struct tcp_accept_framer *f=calloc(1,sizeof(*f));assert(f);
    uint32_t acl=htonl(0x7f000001u);assert(tcp_actor_init(a,3,"127.0.0.1",0,&acl,1,1));
    unsigned length;const unsigned char *out=tcp_framer_output(f,a,&length);
    assert(out&&length==20&&out[5]==TCP_ACTOR_READY);
    assert(tcp_framer_written(f,a,3));out=tcp_framer_output(f,a,&length);
    assert(out&&length==17&&a->out_count==1);
    assert(!tcp_framer_written(f,a,18));assert(tcp_framer_written(f,a,17));
    assert(a->out_count==0);
    unsigned char stop[16]={0};p32(stop,16);stop[4]=1;stop[5]=TCP_ACTOR_STOP;p32(stop+8,1);p32(stop+12,3);
    for(unsigned i=0;i<16;i++){
        unsigned consumed=0;assert(tcp_framer_control(f,a,stop+i,1,&consumed)==1&&consumed==1);
        if(i<15)assert(!tcp_framer_eof(f)&&!a->stopped);
    }
    assert(tcp_framer_eof(f)&&a->stopped);
    out=tcp_framer_output(f,a,&length);assert(out&&length==16&&out[5]==TCP_ACTOR_STOPPED);
    assert(tcp_framer_written(f,a,length));assert(tcp_actor_abort(a));
    memset(f,0,sizeof(*f));unsigned char invalid[4]={15,0,0,0};unsigned consumed=0;
    assert(tcp_framer_feed(f,a,invalid,4,&consumed)==-1&&consumed==4);
    memset(f,0,sizeof(*f));assert(tcp_actor_init(a,3,"127.0.0.1",0,&acl,1,1));
    tcp_actor_pop(a);
    assert(tcp_framer_feed(f,a,stop,16,&consumed)==-1&&consumed==16);
    assert(a->fatal&&a->owner.listener==TCP_ACCEPT_INVALID);
    free(f);free(a);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept framer: ok");return 0;
}
