/* Clock failure in real process after native TCP admission; owned fork cleanup. */
#ifndef _WIN32
#define main tcp_posix_smoke_main
#include "test-tcp-accept-process-posix.c"
#undef main
#include <fcntl.h>
int main(int argc,char **argv) {
    assert(argc==2);signal(SIGABRT,fatal_signal);signal(SIGALRM,fatal_signal);signal(SIGPIPE,SIG_IGN);alarm(15);
    int data[2],control[2],out[2],fault[2];
    assert(pipe(data)==0&&pipe(control)==0&&pipe(out)==0&&pipe(fault)==0);
    int flags=fcntl(fault[0],F_GETFL,0);assert(flags>=0&&fcntl(fault[0],F_SETFL,flags|O_NONBLOCK)==0);
    owned=fork();assert(owned>=0);
    if(!owned) {
        assert(dup2(data[0],0)==0);assert(dup2(out[1],1)==1);
        assert(dup2(control[0],3)==3);assert(dup2(fault[0],4)==4);
        int all[]={data[0],data[1],control[0],control[1],out[0],out[1],fault[0],fault[1]};
        for(unsigned i=0;i<sizeof(all)/sizeof(all[0]);i++)if(all[i]>4)close(all[i]);
        execl(argv[1],argv[1],"127.0.0.1","0","127.0.0.1","1","19","3",(char*)NULL);_exit(127);
    }
    close(data[0]);close(control[0]);close(out[1]);close(fault[0]);
    unsigned char b[128],cmd[64];event(out[0],b,TCP_ACTOR_READY);int s=peer((uint16_t)u32(b+16));
    event(out[0],b,TCP_ACTOR_NEED);frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,17);send_frame(data[1],cmd,24);
    event(out[0],b,TCP_ACTOR_GRANT_RESULT);assert(u32(b+16)==TCP_ACCEPT_ADMITTED&&u64(b+28));
    uint64_t child=u64(b+28);assert(write(fault[1],"F",1)==1);
    frame(cmd,TCP_ACTOR_CREDIT,2,20);p64(cmd+16,child);p64(cmd+24,17);p32(cmd+32,1);
    ssize_t wake=write(data[1],cmd,36);assert(wake==36||(wake<0&&errno==EPIPE));
    int status;assert(waitpid(owned,&status,0)==owned);owned=-1;
    assert(WIFEXITED(status)&&WEXITSTATUS(status)==1);
    struct pollfd p={s,POLLIN,0};assert(poll(&p,1,5000)>0);char byte;assert(recv(s,&byte,1,0)==0);
    assert(read(out[0],&byte,1)==0);
    close(data[1]);close(control[1]);close(out[0]);close(fault[1]);close(s);alarm(0);
    puts("tcp POSIX live child clock failure exit: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX live clock process skipped");return 0;}
#endif
