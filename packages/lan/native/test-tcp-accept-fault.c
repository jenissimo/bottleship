/* Deterministic syscall fault vectors. Compile this TU with tcp-accept-owner.c;
 * it includes flow.c to replace only send, leaving queue/owner logic intact. */
#ifdef _WIN32
#include <winsock2.h>
#else
#include <sys/socket.h>
#include <errno.h>
#endif
#include "tcp-accept-owner.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
static int step;
static int fake_send(tcp_accept_socket socket,const char *bytes,int length,int flags) {
    (void)socket;(void)flags;
    if(step++==0){assert(length==4 && memcmp(bytes,"ABCD",4)==0);return 2;}
    if(step==2) {
#ifdef _WIN32
        WSASetLastError(WSAEWOULDBLOCK);
#else
        errno=EWOULDBLOCK;
#endif
        return -1;
    }
    assert(length==2 && memcmp(bytes,"CD",2)==0);return 2;
}
#define TCP_FLOW_SEND(s,b,n,flags) fake_send(s,b,n,flags)
#include "tcp-accept-flow.c"
int main(void) {
    struct tcp_accept_owner o;struct tcp_accept_flow f;uint32_t id=0;
    memset(&o,0,sizeof(o));o.limit=1;o.slots[0].socket=(tcp_accept_socket)42;
    o.slots[0].child=9;o.slots[0].permit=11;
    tcp_flow_init(&f);assert(tcp_flow_enqueue(&f,TCP_FLOW_DATA,73,"ABCD",4));
    assert(tcp_flow_send(&f,&o,9,11,&id)==TCP_FLOW_PROGRESS && id==0);
    assert(f.count==1 && f.records[f.head].offset==2);
    id=99;assert(tcp_flow_send(&f,&o,9,11,&id)==TCP_FLOW_BLOCKED && id==0);
    assert(f.count==1 && f.records[f.head].offset==2);
    assert(tcp_flow_send(&f,&o,9,11,&id)==TCP_FLOW_DONE && id==73);
    assert(!f.count);id=99;
    assert(tcp_flow_send(&f,&o,9,11,&id)==TCP_FLOW_BLOCKED && id==0 && step==3);
    o.slots[0].poisoned=1;
    assert(tcp_flow_enqueue(&f,TCP_FLOW_DATA,4,"x",1));
    assert(tcp_flow_send(&f,&o,9,11,&id)==TCP_FLOW_ERROR && step==3);
    tcp_flow_retire(&f);puts("tcp accept flow faults: ok");return 0;
}
