/* Full output queue must prevent recv and credit debit until space returns. */
#define main tcp_actor_existing_main
#include "test-tcp-accept-actor.c"
#undef main
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
    n=frame(cmd,TCP_ACTOR_CREDIT,2,20);p64(cmd+16,child);p64(cmd+24,1);p32(cmd+32,TCP_FLOW_WINDOW);
    assert(tcp_actor_command(a,cmd,n)==1);
    tcp_accept_socket s=tcp_accept_data_socket(&a->owner,child,1);
    for(unsigned i=0;i<TCP_ACTOR_NORMAL_OUTPUTS;i++) {
        assert(send(peer,"A",1,0)==1);ready_socket(s);assert(tcp_actor_receive_child(a,child,1)==1);
    }
    assert(a->out_count==TCP_ACTOR_NORMAL_OUTPUTS);
    assert(send(peer,"Z",1,0)==1);ready_socket(s);
    unsigned credit=a->flows[0].credit;assert(tcp_actor_receive_child(a,child,1)==0);
    assert(a->flows[0].credit==credit);char b=0;assert(recv(s,&b,1,MSG_PEEK)==1&&b=='Z');
    tcp_actor_pop(a);assert(tcp_actor_receive_child(a,child,1)==1);
    assert(a->flows[0].credit==credit-1);
    for(unsigned i=1;i<TCP_ACTOR_NORMAL_OUTPUTS;i++)tcp_actor_pop(a);
    const struct tcp_actor_event_record *r=event(a,TCP_ACTOR_DATA);
    assert(r->length==33&&r->bytes[32]=='Z');tcp_actor_pop(a);
    assert(tcp_actor_abort(a)==1);CLOSE_SOCKET(peer);free(a);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept receive pressure: ok");return 0;
}
