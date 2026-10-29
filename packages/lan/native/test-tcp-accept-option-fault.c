/* Native set succeeds while observation fails: inline state must be committed.
 * Compile this TU with owner.c and flow.c; actor.c is included for injection. */
#define main tcp_actor_existing_main
#include "test-tcp-accept-actor.c"
#undef main
#ifdef _WIN32
#define SET_TEST_ERROR() WSASetLastError(WSAEINVAL)
typedef int test_socklen;
#else
#include <errno.h>
#include <netinet/tcp.h>
#define SET_TEST_ERROR() (errno=EINVAL)
typedef socklen_t test_socklen;
#endif
static int fail_get(tcp_accept_socket s,int level,int option,char *value,test_socklen *size) {
    (void)s;(void)level;(void)option;(void)value;(void)size;SET_TEST_ERROR();return -1;
}
#define TCP_ACTOR_GETSOCKOPT(s,l,n,v,z) fail_get(s,l,n,v,z)
#include "tcp-accept-actor.c"
static void ready_socket(tcp_accept_socket s) {
    fd_set set;struct timeval timeout={2,0};FD_ZERO(&set);
#ifndef _WIN32
    assert(s<FD_SETSIZE);
#endif
    FD_SET(s,&set);
#ifdef _WIN32
    assert(select(0,&set,NULL,NULL,&timeout)>0);
#else
    assert(select(s+1,&set,NULL,NULL,&timeout)>0);
#endif
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_actor *a=calloc(1,sizeof(*a));assert(a);uint32_t acl=htonl(0x7f000001u);
    assert(tcp_actor_init(a,77,"127.0.0.1",0,&acl,1,1));
    uint16_t port=(uint16_t)u32(event(a,TCP_ACTOR_READY)->bytes+16);tcp_actor_pop(a);
    tcp_accept_socket peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=TCP_ACCEPT_INVALID);
    struct sockaddr_in name;memset(&name,0,sizeof(name));name.sin_family=AF_INET;name.sin_addr.s_addr=acl;name.sin_port=htons(port);
    assert(connect(peer,(struct sockaddr*)&name,sizeof(name))==0);ready_socket(a->owner.listener);
    assert(tcp_actor_poll_listener(a)==1);tcp_actor_pop(a);
    unsigned char cmd[64];unsigned n=frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,1);
    assert(tcp_actor_command(a,cmd,n)==1);uint64_t child=u64(event(a,TCP_ACTOR_GRANT_RESULT)->bytes+28);tcp_actor_pop(a);
    tcp_accept_socket s=tcp_accept_data_socket(&a->owner,child,1);
    for(unsigned option=0;option<3;option++) {
        n=frame(cmd,TCP_ACTOR_OPTION,10+option,24);p64(cmd+16,child);p64(cmd+24,1);
        p32(cmd+32,option);p32(cmd+36,1);assert(tcp_actor_command(a,cmd,n)==1);
        const struct tcp_actor_event_record *r=event(a,TCP_ACTOR_OPTION_DONE);
        assert(u32(r->bytes+8)==10+option&&u32(r->bytes+40)!=0);tcp_actor_pop(a);
        int observed=0;
#ifdef _WIN32
        int len=sizeof(observed);
#else
        socklen_t len=sizeof(observed);
#endif
        int level=option==2?IPPROTO_TCP:SOL_SOCKET;
        int name_opt=option==0?SO_OOBINLINE:option==1?SO_KEEPALIVE:TCP_NODELAY;
        assert(getsockopt(s,level,name_opt,(char*)&observed,&len)==0&&observed);
    }
    assert(a->flows[0].inline_mode==1);
    assert(send(peer,"!",1,MSG_OOB)==1);ready_socket(s);
    n=frame(cmd,TCP_ACTOR_CREDIT,20,20);p64(cmd+16,child);p64(cmd+24,1);p32(cmd+32,1);
    assert(tcp_actor_command(a,cmd,n)==1);assert(tcp_actor_receive_child(a,child,1)==1);
    const struct tcp_actor_event_record *r=event(a,TCP_ACTOR_DATA);
    assert(r->length==33&&r->bytes[32]=='!');tcp_actor_pop(a);
    assert(tcp_actor_abort(a)==1);CLOSE_SOCKET(peer);free(a);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept option set/get fault: ok");return 0;
}
