/* POSIX owned fork/pipe/loopback integration test for source-stage actor. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/wait.h>
#include <arpa/inet.h>
#include <poll.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "tcp-accept-actor.h"
static pid_t owned=-1;
static void fatal_signal(int sig) {
    if(owned>0)(void)kill(owned,SIGKILL);
    _exit(128+sig);
}
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
static void p64(unsigned char *p,uint64_t n){p32(p,(uint32_t)n);p32(p+4,(uint32_t)(n>>32));}
static uint32_t u32(const unsigned char *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static uint64_t u64(const unsigned char *p){return (uint64_t)u32(p)|((uint64_t)u32(p+4)<<32);}
static void frame(unsigned char *p,unsigned op,unsigned id,unsigned size) {
    memset(p,0,16+size);p32(p,16+size);p[4]=1;p[5]=(unsigned char)op;p32(p+8,id);p32(p+12,19);
}
static void send_frame(int fd,const unsigned char *p,unsigned size) {
    while(size) {ssize_t n=write(fd,p,size);assert(n>0);p+=n;size-=(unsigned)n;}
}
static void read_exact(int fd,unsigned char *p,unsigned size) {
    while(size) {
        struct pollfd f={fd,POLLIN,0};assert(poll(&f,1,5000)>0);
        ssize_t n=read(fd,p,size);assert(n>0);p+=n;size-=(unsigned)n;
    }
}
static unsigned event(int fd,unsigned char *b,unsigned op) {
    read_exact(fd,b,16);unsigned length=u32(b);assert(length>=16&&length<=128);
    read_exact(fd,b+16,length-16);assert(b[4]==1&&b[5]==op&&u32(b+12)==19);return length;
}
static int peer(uint16_t port) {
    int s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(s>=0);
    struct sockaddr_in a;memset(&a,0,sizeof(a));a.sin_family=AF_INET;
    a.sin_addr.s_addr=htonl(0x7f000001u);a.sin_port=htons(port);
    assert(connect(s,(struct sockaddr*)&a,sizeof(a))==0);return s;
}
int main(int argc,char **argv) {
    assert(argc==2);signal(SIGABRT,fatal_signal);signal(SIGALRM,fatal_signal);alarm(30);
    int data[2],control[2],out[2];assert(pipe(data)==0&&pipe(control)==0&&pipe(out)==0);
    owned=fork();assert(owned>=0);
    if(!owned) {
        assert(dup2(data[0],0)==0);assert(dup2(out[1],1)==1);assert(dup2(control[0],3)==3);
        int all[]={data[0],data[1],control[0],control[1],out[0],out[1]};
        for(unsigned i=0;i<sizeof(all)/sizeof(all[0]);i++)if(all[i]>3)close(all[i]);
        execl(argv[1],argv[1],"127.0.0.1","0","127.0.0.1","2","19","3",(char*)NULL);_exit(127);
    }
    close(data[0]);close(control[0]);close(out[1]);
    unsigned char b[128],cmd[64];event(out[0],b,TCP_ACTOR_READY);
    uint16_t port=(uint16_t)u32(b+16);assert(port);int a=peer(port);
    event(out[0],b,TCP_ACTOR_NEED);frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,17);send_frame(data[1],cmd,24);
    event(out[0],b,TCP_ACTOR_GRANT_RESULT);assert(u32(b+16)==TCP_ACCEPT_ADMITTED);
    uint64_t child=u64(b+28);assert(child&&u64(b+20)==17);
    frame(cmd,TCP_ACTOR_STOP,2,0);send_frame(control[1],cmd,16);event(out[0],b,TCP_ACTOR_STOPPED);
    frame(cmd,TCP_ACTOR_WRITE,3,21);p64(cmd+16,child);p64(cmd+24,17);p32(cmd+32,4);cmd[36]='Q';send_frame(data[1],cmd,37);
    event(out[0],b,TCP_ACTOR_ACK);assert(u64(b+16)==child&&u32(b+32)==4);
    struct pollfd socket_ready={a,POLLIN,0};assert(poll(&socket_ready,1,5000)>0);char c;
    assert(recv(a,&c,1,0)==1&&c=='Q');
    assert(send(a,"XY",2,0)==2);
    frame(cmd,TCP_ACTOR_CREDIT,4,20);p64(cmd+16,child);p64(cmd+24,17);p32(cmd+32,2);send_frame(data[1],cmd,36);
    unsigned received=0;while(received<2) {
        unsigned n=event(out[0],b,TCP_ACTOR_DATA)-32;assert(n&&n<=2-received);
        assert(memcmp(b+32,"XY"+received,n)==0);received+=n;
    }
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,5,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(control[1],cmd,32);
    event(out[0],b,TCP_ACTOR_CHILD_CLOSED);assert(u64(b+16)==child&&u64(b+24)==17);
    frame(cmd,TCP_ACTOR_CONTROL_FENCE,6,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(control[1],cmd,32);
    event(out[0],b,TCP_ACTOR_FENCE_DONE);
    frame(cmd,TCP_ACTOR_BARRIER,7,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(data[1],cmd,32);
    event(out[0],b,TCP_ACTOR_BARRIER_DONE);
    frame(cmd,TCP_ACTOR_QUIESCE,8,0);send_frame(data[1],cmd,16);
    event(out[0],b,TCP_ACTOR_QUIESCED);assert(u32(b+8)==8);
    frame(cmd,TCP_ACTOR_EXIT,9,0);send_frame(control[1],cmd,16);
    event(out[0],b,TCP_ACTOR_EXITING);assert(u32(b+8)==9);
    int status;assert(waitpid(owned,&status,0)==owned);
    owned=-1;assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);
    char tail;assert(read(out[0],&tail,1)==0);
    close(data[1]);close(control[1]);close(out[0]);close(a);alarm(0);
    puts("tcp POSIX graceful process: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX process test skipped");return 0;}
#endif
