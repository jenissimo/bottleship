/* Prove POSIX poll wrapper admits > Windows' 60 children. */
#ifndef _WIN32
#define main tcp_posix_smoke_main
#include "test-tcp-accept-process-posix.c"
#undef main
int main(int argc,char **argv) {
    assert(argc==2);signal(SIGABRT,fatal_signal);signal(SIGALRM,fatal_signal);alarm(40);
    int data[2],control[2],out[2];assert(pipe(data)==0&&pipe(control)==0&&pipe(out)==0);
    owned=fork();assert(owned>=0);
    if(!owned) {
        assert(dup2(data[0],0)==0);assert(dup2(out[1],1)==1);assert(dup2(control[0],3)==3);
        int all[]={data[0],data[1],control[0],control[1],out[0],out[1]};
        for(unsigned i=0;i<sizeof(all)/sizeof(all[0]);i++)if(all[i]>3)close(all[i]);
        execl(argv[1],argv[1],"127.0.0.1","0","127.0.0.1","80","19","3",(char*)NULL);_exit(127);
    }
    close(data[0]);close(control[0]);close(out[1]);
    unsigned char b[128],cmd[64];event(out[0],b,TCP_ACTOR_READY);uint16_t port=(uint16_t)u32(b+16);
    int peers[70];uint64_t ids[70];
    for(unsigned i=0;i<70;i++) {
        peers[i]=peer(port);event(out[0],b,TCP_ACTOR_NEED);
        frame(cmd,TCP_ACTOR_GRANT,i+1,8);p64(cmd+16,i+1);send_frame(data[1],cmd,24);
        event(out[0],b,TCP_ACTOR_GRANT_RESULT);assert(u32(b+16)==TCP_ACCEPT_ADMITTED);
        ids[i]=u64(b+28);assert(ids[i]);
    }
    assert(ids[69]!=ids[0]);assert(send(peers[69],"Z",1,0)==1);
    frame(cmd,TCP_ACTOR_CREDIT,90,20);p64(cmd+16,ids[69]);p64(cmd+24,70);p32(cmd+32,1);send_frame(data[1],cmd,36);
    event(out[0],b,TCP_ACTOR_DATA);assert(u64(b+16)==ids[69]&&b[32]=='Z');
    close(data[1]);close(control[1]);int status;assert(waitpid(owned,&status,0)==owned);
    owned=-1;assert(WIFEXITED(status)&&WEXITSTATUS(status)==1);
    close(out[0]);for(unsigned i=0;i<70;i++)close(peers[i]);alarm(0);
    puts("tcp POSIX process 70 children: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX process many skipped");return 0;}
#endif
