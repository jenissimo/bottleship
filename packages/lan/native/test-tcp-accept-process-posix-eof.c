/* EOF on one pipe must retire a live child before observed process exit. */
#ifndef _WIN32
#define main tcp_posix_smoke_main
#include "test-tcp-accept-process-posix.c"
#undef main
int main(int argc,char **argv) {
    assert(argc==2);signal(SIGABRT,fatal_signal);signal(SIGALRM,fatal_signal);alarm(30);
    int data[2],control[2],out[2];assert(pipe(data)==0&&pipe(control)==0&&pipe(out)==0);
    owned=fork();assert(owned>=0);
    if(!owned) {
        assert(dup2(data[0],0)==0);assert(dup2(out[1],1)==1);assert(dup2(control[0],3)==3);
        int all[]={data[0],data[1],control[0],control[1],out[0],out[1]};
        for(unsigned i=0;i<sizeof(all)/sizeof(all[0]);i++)if(all[i]>3)close(all[i]);
        execl(argv[1],argv[1],"127.0.0.1","0","127.0.0.1","1","19","3",(char*)NULL);_exit(127);
    }
    close(data[0]);close(control[0]);close(out[1]);
    unsigned char b[128],cmd[64];event(out[0],b,TCP_ACTOR_READY);int s=peer((uint16_t)u32(b+16));
    event(out[0],b,TCP_ACTOR_NEED);frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,17);send_frame(data[1],cmd,24);
    event(out[0],b,TCP_ACTOR_GRANT_RESULT);assert(u32(b+16)==TCP_ACCEPT_ADMITTED&&u64(b+28));
    close(data[1]);int status;assert(waitpid(owned,&status,0)==owned);owned=-1;
    assert(WIFEXITED(status)&&WEXITSTATUS(status)==1);
    struct pollfd p={s,POLLIN,0};assert(poll(&p,1,5000)>0);char c;assert(recv(s,&c,1,0)==0);
    close(control[1]);close(out[0]);close(s);alarm(0);
    puts("tcp POSIX process live EOF cleanup: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX process EOF skipped");return 0;}
#endif
