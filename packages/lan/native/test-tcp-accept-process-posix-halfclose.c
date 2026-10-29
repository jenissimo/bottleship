/* Real peer half-close + a non-reading, bounded receiver fills native send. */
#ifndef _WIN32
#define main tcp_posix_smoke_main
#include "test-tcp-accept-process-posix.c"
#undef main
int main(int argc,char **argv) {
    assert(argc==2);signal(SIGABRT,fatal_signal);signal(SIGALRM,fatal_signal);signal(SIGPIPE,SIG_IGN);alarm(45);
    int data[2],control[2],out[2];assert(pipe(data)==0&&pipe(control)==0&&pipe(out)==0);
    owned=fork();assert(owned>=0);
    if(!owned) {
        assert(dup2(data[0],0)==0);assert(dup2(out[1],1)==1);assert(dup2(control[0],3)==3);
        int all[]={data[0],data[1],control[0],control[1],out[0],out[1]};
        for(unsigned i=0;i<sizeof(all)/sizeof(all[0]);i++)if(all[i]>3)close(all[i]);
        execl(argv[1],argv[1],"127.0.0.1","0","127.0.0.1","2","19","3",(char*)NULL);_exit(127);
    }
    close(data[0]);close(control[0]);close(out[1]);
    unsigned char b[128],cmd[64];event(out[0],b,TCP_ACTOR_READY);uint16_t port=(uint16_t)u32(b+16);
    int s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(s>=0);int tiny=1024;
    assert(setsockopt(s,SOL_SOCKET,SO_RCVBUF,&tiny,sizeof(tiny))==0);
    struct sockaddr_in addr;memset(&addr,0,sizeof(addr));addr.sin_family=AF_INET;
    addr.sin_addr.s_addr=htonl(0x7f000001u);addr.sin_port=htons(port);
    assert(connect(s,(struct sockaddr*)&addr,sizeof(addr))==0);
    event(out[0],b,TCP_ACTOR_NEED);frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,17);send_frame(data[1],cmd,24);
    event(out[0],b,TCP_ACTOR_GRANT_RESULT);uint64_t child=u64(b+28);assert(child);
    int second=peer(port);event(out[0],b,TCP_ACTOR_NEED);
    frame(cmd,TCP_ACTOR_GRANT,2,8);p64(cmd+16,18);send_frame(data[1],cmd,24);
    event(out[0],b,TCP_ACTOR_GRANT_RESULT);uint64_t child_b=u64(b+28);assert(child_b);
    assert(shutdown(s,SHUT_WR)==0);
    unsigned char *large=calloc(1,16+20+16384);assert(large);
    int stalled=0;
    for(unsigned i=1;i<=2048;i++) {
        frame(large,TCP_ACTOR_WRITE,10+i,20+16384);p64(large+16,child);p64(large+24,17);p32(large+32,i);
        memset(large+36,'X',16384);send_frame(data[1],large,16+20+16384);
        struct pollfd p={out[0],POLLIN,0};int ready=poll(&p,1,500);
        assert(ready>=0);
        if(!ready){stalled=1;break;}
        event(out[0],b,TCP_ACTOR_ACK);assert(u32(b+32)==i);
    }
    assert(stalled);free(large);
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,5000,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(control[1],cmd,32);
    for(;;) {
        read_exact(out[0],b,16);unsigned n=u32(b);assert(n>=16&&n<=128);read_exact(out[0],b+16,n-16);
        if(b[5]==TCP_ACTOR_CHILD_CLOSED){assert(u64(b+16)==child);break;}
        assert(b[5]==TCP_ACTOR_ACK);
    }
    frame(cmd,TCP_ACTOR_WRITE,5001,21);p64(cmd+16,child_b);p64(cmd+24,18);p32(cmd+32,5001);cmd[36]='B';send_frame(data[1],cmd,37);
    event(out[0],b,TCP_ACTOR_ACK);assert(u64(b+16)==child_b);
    struct pollfd readable={second,POLLIN,0};assert(poll(&readable,1,5000)>0);char v;assert(recv(second,&v,1,0)==1&&v=='B');
    close(data[1]);close(control[1]);int status;assert(waitpid(owned,&status,0)==owned);owned=-1;
    assert(WIFEXITED(status)&&WEXITSTATUS(status)==1);
    close(out[0]);close(s);close(second);alarm(0);puts("tcp POSIX real half-close and blocked send: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX process halfclose skipped");return 0;}
#endif
