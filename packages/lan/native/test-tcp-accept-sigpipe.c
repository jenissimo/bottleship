/* POSIX child process verifies that failed native sends do not raise SIGPIPE.
 * Compile with tcp-accept-owner.c and tcp-accept-flow.c. */
#ifdef _WIN32
#include <stdio.h>
int main(void) { puts("SIGPIPE test: POSIX only");return 0; }
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <signal.h>
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include "tcp-accept-flow.h"
int main(void) {
    struct tcp_accept_owner o;struct tcp_accept_outcome c;uint16_t port;
    uint32_t acl=htonl(0x7f000001u);
    assert(tcp_accept_init(&o,"127.0.0.1",0,&acl,1,1,&port));
    int peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer>=0);
    struct sockaddr_in a;memset(&a,0,sizeof(a));a.sin_family=AF_INET;
    a.sin_addr.s_addr=acl;a.sin_port=htons(port);
    assert(connect(peer,(struct sockaddr*)&a,sizeof(a))==0);
    fd_set set;struct timeval t={2,0};FD_ZERO(&set);assert(o.listener<FD_SETSIZE);
    FD_SET(o.listener,&set);assert(select(o.listener+1,&set,NULL,NULL,&t)>0);
    assert(tcp_accept_grant(&o,1,&c)==TCP_ACCEPT_ADMITTED);
    int accepted=tcp_accept_data_socket(&o,c.child,c.permit);assert(accepted>=0 && accepted<FD_SETSIZE);
    assert(shutdown(peer,SHUT_RDWR)==0);assert(close(peer)==0);
    FD_ZERO(&set);FD_SET(accepted,&set);t.tv_sec=2;t.tv_usec=0;
    assert(select(accepted+1,&set,NULL,NULL,&t)>0);char x;
    assert(recv(accepted,&x,1,0)==0);
    pid_t pid=fork();assert(pid>=0);
    if(pid==0) {
        signal(SIGPIPE,SIG_DFL);
        struct tcp_accept_flow f;tcp_flow_init(&f);uint32_t id;
        /* A graceful peer close may allow one send; later send reports failure. */
        for(unsigned i=0;i<100;i++) {
            if(!tcp_flow_enqueue(&f,TCP_FLOW_DATA,i+1,"x",1))_exit(2);
            int result=tcp_flow_send(&f,&o,c.child,c.permit,&id);
            if(result==TCP_FLOW_ERROR)_exit(0);
            if(result!=TCP_FLOW_DONE)_exit(3);
        }
        _exit(4);
    }
    int status;assert(waitpid(pid,&status,0)==pid);
    assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);
    assert(tcp_accept_close(&o,c.child,c.permit)==1);assert(tcp_accept_stop(&o)==1);
    puts("tcp accept SIGPIPE: ok");return 0;
}
#endif
