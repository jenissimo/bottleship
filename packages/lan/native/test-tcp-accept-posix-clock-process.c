/* Actual process must exit on clock failure while both pipes remain open. */
#ifndef _WIN32
#define main tcp_posix_smoke_main
#include "test-tcp-accept-process-posix.c"
#undef main
int main(int argc,char **argv) {
    assert(argc==2);signal(SIGABRT,fatal_signal);signal(SIGALRM,fatal_signal);alarm(10);
    int data[2],control[2],out[2];assert(pipe(data)==0&&pipe(control)==0&&pipe(out)==0);
    owned=fork();assert(owned>=0);
    if(!owned) {
        assert(dup2(data[0],0)==0);assert(dup2(out[1],1)==1);assert(dup2(control[0],3)==3);
        int all[]={data[0],data[1],control[0],control[1],out[0],out[1]};
        for(unsigned i=0;i<sizeof(all)/sizeof(all[0]);i++)if(all[i]>3)close(all[i]);
        execl(argv[1],argv[1],"127.0.0.1","0","127.0.0.1","1","19","3",(char*)NULL);_exit(127);
    }
    close(data[0]);close(control[0]);close(out[1]);int status;
    assert(waitpid(owned,&status,0)==owned);owned=-1;
    assert(WIFEXITED(status)&&WEXITSTATUS(status)==1);
    char byte;assert(read(out[0],&byte,1)==0);
    close(data[1]);close(control[1]);close(out[0]);alarm(0);
    puts("tcp POSIX clock failure process exit: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX clock process skipped");return 0;}
#endif
