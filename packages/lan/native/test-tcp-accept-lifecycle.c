/* Lifecycle validation and late GRANT, using real loopback sockets. */
#define main tcp_barrier_existing_main
#include "test-tcp-accept-barrier.c"
#undef main
static void init_pair(struct tcp_accept_actor **a,struct tcp_accept_framer **f,uint16_t *port) {
    *a=calloc(1,sizeof(**a));*f=calloc(1,sizeof(**f));assert(*a&&*f);
    uint32_t acl=htonl(0x7f000001u);assert(tcp_actor_init(*a,19,"127.0.0.1",0,&acl,1,1));
    *port=(uint16_t)u32(expect(*a,TCP_ACTOR_READY)->bytes+16);tcp_actor_pop(*a);
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_actor *a;struct tcp_accept_framer *f;uint16_t port;unsigned char cmd[64];unsigned used;
    init_pair(&a,&f,&port);
    frame(cmd,TCP_ACTOR_QUIESCE,1,0);
    assert(tcp_framer_feed(f,a,cmd,16,&used)==-1&&a->fatal);
    assert(tcp_actor_peek(a)==NULL&&a->owner.listener==TCP_ACCEPT_INVALID);free(f);free(a);
    init_pair(&a,&f,&port);frame(cmd,TCP_ACTOR_EXIT,9,0);
    assert(tcp_framer_control(f,a,cmd,16,&used)==-1&&a->fatal);
    assert(tcp_actor_peek(a)==NULL&&a->owner.listener==TCP_ACCEPT_INVALID);free(f);free(a);

    /* NEED→STOP→late GRANT is returned before QUIESCED; a quiet listener has
       no other ownership and the ordered data fence closes grant admission. */
    init_pair(&a,&f,&port);tcp_accept_socket s=peer(port);need(a,f);
    frame(cmd,TCP_ACTOR_STOP,2,0);assert(tcp_framer_control(f,a,cmd,16,&used)==1);
    expect(a,TCP_ACTOR_STOPPED);tcp_actor_pop(a);
    frame(cmd,TCP_ACTOR_GRANT,3,8);p64(cmd+16,1);assert(tcp_framer_feed(f,a,cmd,24,&used)==1);
    const struct tcp_actor_event_record *r=expect(a,TCP_ACTOR_GRANT_RESULT);
    assert(u32(r->bytes+16)==TCP_ACCEPT_UNUSED&&u64(r->bytes+20)==1);tcp_actor_pop(a);
    frame(cmd,TCP_ACTOR_QUIESCE,4,0);assert(tcp_framer_feed(f,a,cmd,16,&used)==1);
    expect(a,TCP_ACTOR_QUIESCED);tcp_actor_pop(a);assert(!a->late_grant);
    frame(cmd,TCP_ACTOR_EXIT,5,0);assert(tcp_framer_control(f,a,cmd,16,&used)==1);
    expect(a,TCP_ACTOR_EXITING);tcp_actor_pop(a);assert(f->exit_requested);
    assert(tcp_actor_abort(a));CLOSE_SOCKET(s);free(f);free(a);

    /* STOP does not close an accepted child; premature QUIESCE must not
       report success and closes owned resources through failure cleanup. */
    init_pair(&a,&f,&port);s=peer(port);need(a,f);
    frame(cmd,TCP_ACTOR_GRANT,6,8);p64(cmd+16,2);assert(tcp_framer_feed(f,a,cmd,24,&used)==1);
    r=expect(a,TCP_ACTOR_GRANT_RESULT);uint64_t child=u64(r->bytes+28);tcp_actor_pop(a);assert(child);
    frame(cmd,TCP_ACTOR_STOP,7,0);assert(tcp_framer_control(f,a,cmd,16,&used)==1);
    expect(a,TCP_ACTOR_STOPPED);tcp_actor_pop(a);
    frame(cmd,TCP_ACTOR_QUIESCE,8,0);assert(tcp_framer_feed(f,a,cmd,16,&used)==-1);
    assert(a->fatal&&tcp_actor_peek(a)==NULL);
    assert(tcp_accept_data_socket(&a->owner,child,2)==TCP_ACCEPT_INVALID);
    CLOSE_SOCKET(s);free(f);free(a);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept graceful lifecycle: ok");return 0;
}
