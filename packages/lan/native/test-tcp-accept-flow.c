/* Finite real-loopback exercise of child escrow, OOB, FIN, credit and ownership. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSE_SOCKET closesocket
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <arpa/inet.h>
#include <unistd.h>
#define CLOSE_SOCKET close
#endif
#include "tcp-accept-flow.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int wait_for(tcp_accept_socket s,int mode) {
    fd_set set;struct timeval timeout={2,0};FD_ZERO(&set);
#ifndef _WIN32
    assert(s<FD_SETSIZE);
#endif
    FD_SET(s,&set);
#ifdef _WIN32
    return select(0,mode==0?&set:NULL,mode==1?&set:NULL,mode==2?&set:NULL,&timeout)>0;
#else
    return select(s+1,mode==0?&set:NULL,mode==1?&set:NULL,mode==2?&set:NULL,&timeout)>0;
#endif
}
static void flush_one(struct tcp_accept_flow *f,struct tcp_accept_owner *owner,struct tcp_accept_outcome *child,uint32_t expected) {
    tcp_accept_socket s=tcp_accept_data_socket(owner,child->child,child->permit);
    uint32_t id=999;int result;
    do {
        result=tcp_flow_send(f,owner,child->child,child->permit,&id);
        assert(result!=TCP_FLOW_ERROR);
        if(result==TCP_FLOW_BLOCKED)assert(wait_for(s,1));
    } while(result!=TCP_FLOW_DONE);
    assert(id==expected);
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_owner owner;struct tcp_accept_outcome child;struct tcp_accept_flow flow;
    uint32_t acl=htonl(0x7f000001u);uint16_t port;
    assert(tcp_accept_init(&owner,"127.0.0.1",0,&acl,1,1,&port));
    tcp_accept_socket peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=TCP_ACCEPT_INVALID);
    struct sockaddr_in address;memset(&address,0,sizeof(address));address.sin_family=AF_INET;
    address.sin_addr.s_addr=acl;address.sin_port=htons(port);
    assert(connect(peer,(struct sockaddr*)&address,sizeof(address))==0);
    assert(wait_for(owner.listener,0));
    assert(tcp_accept_grant(&owner,1,&child)==TCP_ACCEPT_ADMITTED);
    tcp_accept_socket accepted=owner.slots[0].socket;assert(accepted!=TCP_ACCEPT_INVALID);
    tcp_flow_init(&flow);
    assert(tcp_flow_credit(&flow,TCP_FLOW_WINDOW));
    assert(!tcp_flow_credit(&flow,1));
    assert(!tcp_flow_debit(&flow,TCP_FLOW_WINDOW+1));
    assert(tcp_flow_debit(&flow,7));assert(flow.credit==TCP_FLOW_WINDOW-7);
    assert(tcp_flow_credit(&flow,7));

    char copied[]="ABC";char urgent='!';
    assert(tcp_flow_enqueue(&flow,TCP_FLOW_DATA,1,copied,3));
    assert(tcp_flow_enqueue(&flow,TCP_FLOW_OOB,2,&urgent,1));
    assert(tcp_flow_enqueue(&flow,TCP_FLOW_FIN,0,NULL,0));
    copied[0]='X';urgent='?';
    assert(!tcp_flow_enqueue(&flow,TCP_FLOW_DATA,3,copied,3));
    flush_one(&flow,&owner,&child,1);
    char received[4]={0};unsigned got=0;
    while(got<3) {
        assert(wait_for(peer,0));int n=recv(peer,received+got,(int)(3-got),0);
        assert(n>0);got+=(unsigned)n;
    }
    assert(memcmp(received,"ABC",3)==0);
    flush_one(&flow,&owner,&child,2);
    assert(wait_for(peer,2));assert(recv(peer,received,1,MSG_OOB)==1&&received[0]=='!');
    flush_one(&flow,&owner,&child,0);assert(flow.fin_sent);
    assert(wait_for(peer,0));assert(recv(peer,received,1,0)==0);
    assert(tcp_accept_stop(&owner)==1);
    tcp_flow_retire(&flow);assert(!tcp_flow_credit(&flow,1));
    assert(tcp_accept_close(&owner,child.child,child.permit)==1);
    CLOSE_SOCKET(peer);

    /* Bounds cannot mutate existing escrow. FIN has a slot
     * even when all DATA records are occupied. */
    tcp_flow_init(&flow);char x='a';
    for(unsigned i=1;i<=TCP_FLOW_RECORDS;i++)
        assert(tcp_flow_enqueue(&flow,TCP_FLOW_DATA,i,&x,1));
    assert(!tcp_flow_enqueue(&flow,TCP_FLOW_DATA,TCP_FLOW_RECORDS+1,&x,1));
    assert(tcp_flow_enqueue(&flow,TCP_FLOW_FIN,0,NULL,0));
    assert(flow.count==TCP_FLOW_RECORDS+1);
    tcp_flow_retire(&flow);assert(flow.count==0 && flow.payload==0);
    tcp_flow_init(&flow);
    assert(tcp_flow_enqueue(&flow,TCP_FLOW_DATA,3,&x,1));
    assert(tcp_flow_enqueue(&flow,TCP_FLOW_DATA,3,&x,1)); /* Opaque IDs, as in tcp-io.h. */
    assert(!tcp_flow_enqueue(&flow,TCP_FLOW_OOB,4,&x,2));
    tcp_flow_retire(&flow);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept flow contract: ok");return 0;
}
