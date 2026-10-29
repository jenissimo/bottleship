/* Block stdout/data stream then exercise the independent POSIX control pipe. */
#ifndef _WIN32
#define main tcp_posix_smoke_main
#include "test-tcp-accept-process-posix.c"
#undef main
int main(int argc,char **argv) {
    assert(argc==2);signal(SIGABRT,fatal_signal);signal(SIGALRM,fatal_signal);signal(SIGPIPE,SIG_IGN);alarm(40);
    int data[2],control[2],out[2];assert(pipe(data)==0&&pipe(control)==0&&pipe(out)==0);
    owned=fork();assert(owned>=0);
    if(!owned) {
        assert(dup2(data[0],0)==0);assert(dup2(out[1],1)==1);assert(dup2(control[0],3)==3);
        int all[]={data[0],data[1],control[0],control[1],out[0],out[1]};
        for(unsigned i=0;i<sizeof(all)/sizeof(all[0]);i++)if(all[i]>3)close(all[i]);
        execl(argv[1],argv[1],"127.0.0.1","0","127.0.0.1","1","19","3",(char*)NULL);_exit(127);
    }
    close(data[0]);close(control[0]);close(out[1]);
    unsigned char b[128],cmd[64];event(out[0],b,TCP_ACTOR_READY);uint16_t port=(uint16_t)u32(b+16);
    int s=peer(port);event(out[0],b,TCP_ACTOR_NEED);
    frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,17);send_frame(data[1],cmd,24);
    event(out[0],b,TCP_ACTOR_GRANT_RESULT);uint64_t child=u64(b+28);assert(child);
    pid_t writer=fork();assert(writer>=0);
    if(!writer) {
        close(control[1]);close(out[0]);close(s);
        for(unsigned i=1;i<=20000;i++) {
            frame(cmd,TCP_ACTOR_WRITE,i+10,21);p64(cmd+16,child);p64(cmd+24,17);p32(cmd+32,i);cmd[36]='X';
            ssize_t n=write(data[1],cmd,37);if(n!=37)break;
        }
        _exit(0);
    }
    /* A bounded wait verifies the writer cannot complete while stdout is held. */
    (void)poll(NULL,0,1000);int writer_status;assert(waitpid(writer,&writer_status,WNOHANG)==0);
    frame(cmd,TCP_ACTOR_STOP,2,0);send_frame(control[1],cmd,16);
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,3,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(control[1],cmd,32);
    int stopped=0,closed=0;
    for(unsigned i=0;i<20000&&!closed;i++) {
        read_exact(out[0],b,16);unsigned length=u32(b);assert(length>=16&&length<=128);
        read_exact(out[0],b+16,length-16);
        if(b[5]==TCP_ACTOR_STOPPED)stopped=1;
        else if(b[5]==TCP_ACTOR_CHILD_CLOSED){assert(u64(b+16)==child);closed=1;}
        else assert(b[5]==TCP_ACTOR_ACK);
    }
    assert(stopped&&closed);kill(writer,SIGTERM);assert(waitpid(writer,&writer_status,0)==writer);
    close(data[1]);close(control[1]);int status;assert(waitpid(owned,&status,0)==owned);
    owned=-1;assert(WIFEXITED(status)&&WEXITSTATUS(status)==1);
    close(out[0]);close(s);alarm(0);puts("tcp POSIX process stdout pressure: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX process pressure skipped");return 0;}
#endif
