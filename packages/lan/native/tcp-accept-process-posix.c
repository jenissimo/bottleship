/* POSIX source-stage TCP actor process. Not wired into production.
 * argv: bind IPv4, port, ACL IPv4, max children, epoch, control fd.
 * stdin=data, stdout=events, separate inherited fd=control. Apache-2.0. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <arpa/inet.h>
#include <poll.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "tcp-accept-framer.h"
#define CHUNK 4096
#define HUP_RETRY_MS 50u
#ifndef TCP_POSIX_POLL
#define TCP_POSIX_POLL(f,n,t) poll(f,n,t)
#endif
#ifndef TCP_POSIX_FLUSH
#define TCP_POSIX_FLUSH(a,c,p) tcp_actor_flush_child(a,c,p)
#endif
#ifndef TCP_POSIX_WRITE
#define TCP_POSIX_WRITE(fd,b,n) write(fd,b,n)
#endif
#ifndef TCP_POSIX_CLOCK
static uint64_t monotonic_ms(void) {
    struct timespec t;
    if(clock_gettime(CLOCK_MONOTONIC,&t)!=0||t.tv_sec<0||
       (uint64_t)t.tv_sec>(UINT64_MAX-1000u-HUP_RETRY_MS)/1000u)return UINT64_MAX;
    return (uint64_t)t.tv_sec*1000u+(uint64_t)t.tv_nsec/1000000u;
}
#define TCP_POSIX_CLOCK() monotonic_ms()
#endif
struct lane { int fd;unsigned length;unsigned char bytes[CHUNK]; };
struct child_state {uint64_t child,permit,retry_ms;int error,hangup;};
static struct tcp_accept_actor *actor;
static struct tcp_accept_framer *framer;
static struct child_state children[TCP_ACCEPT_MAX];
static int nonblock(int fd) {
    int flags=fcntl(fd,F_GETFL,0);return flags>=0&&fcntl(fd,F_SETFL,flags|O_NONBLOCK)==0;
}
static int parse_u32(const char *s,uint32_t *value) {
    char *end;unsigned long n;if(!s||!*s)return 0;
    for(const char *p=s;*p;p++)if(*p<'0'||*p>'9')return 0;
    errno=0;n=strtoul(s,&end,10);if(errno||*end||n>UINT32_MAX)return 0;
    *value=(uint32_t)n;return 1;
}
static int parse_acl(const char *text,uint32_t *acl,unsigned *count) {
    unsigned n=0;
    if(!text||!*text)return 0;
    for(;;) {
        const char *end=strchr(text,',');
        size_t len=end?(size_t)(end-text):strlen(text);
        char host[16];struct in_addr address;
        if(!len||len>=sizeof(host)||n>=32)return 0;
        memcpy(host,text,len);host[len]='\0';
        if(inet_pton(AF_INET,host,&address)!=1)return 0;
        acl[n++]=(uint32_t)address.s_addr;
        if(!end)break;
        text=end+1;
    }
    *count=n;return 1;
}
static int process_lane(struct lane *lane,int control) {
    unsigned used=0;int n;
    if(!lane->length)return 0;
    n=control?tcp_framer_control(framer,actor,lane->bytes,lane->length,&used):
              tcp_framer_feed(framer,actor,lane->bytes,lane->length,&used);
    if(n<0)return -1;
    if(used){lane->length-=used;if(lane->length)memmove(lane->bytes,lane->bytes+used,lane->length);return 1;}
    return 0;
}
static int read_lane(struct lane *lane) {
    ssize_t n=read(lane->fd,lane->bytes,sizeof(lane->bytes));
    if(n>0){lane->length=(unsigned)n;return 1;}
    if(n<0&&(errno==EAGAIN||errno==EWOULDBLOCK||errno==EINTR))return 0;
    return -1;
}
static int write_output(void) {
    unsigned size;const unsigned char *bytes=tcp_framer_output(framer,actor,&size);
    if(!bytes)return 0;
    ssize_t n=TCP_POSIX_WRITE(STDOUT_FILENO,bytes,size);
    if(n>0)return tcp_framer_written(framer,actor,(unsigned)n)?1:-1;
    if(n<0&&(errno==EAGAIN||errno==EWOULDBLOCK||errno==EINTR))return 0;
    return -1;
}
static void sync_child(unsigned i) {
    struct tcp_accept_slot *slot=&actor->owner.slots[i];
    uint64_t child=slot->socket==TCP_ACCEPT_INVALID?0:slot->child;
    uint64_t permit=slot->socket==TCP_ACCEPT_INVALID?0:slot->permit;
    if(children[i].child!=child||children[i].permit!=permit) {
        children[i].child=child;children[i].permit=permit;
        children[i].error=0;children[i].hangup=0;children[i].retry_ms=0;
    }
}
static int capacity(void) {
    unsigned live=framer->closed_count;
    for(unsigned i=0;i<actor->owner.limit;i++)
        if(actor->owner.slots[i].socket!=TCP_ACCEPT_INVALID)live++;
    return live<TCP_ACCEPT_MAX;
}
static int run(struct lane *data,struct lane *control) {
    for(;;) {
        int progress=0,n;unsigned used;
        uint64_t now=TCP_POSIX_CLOCK();
        if(now>=UINT64_MAX-HUP_RETRY_MS) {
            fprintf(stderr,"tcp-accept monotonic clock failure\n");return 1;
        }
        n=process_lane(control,1);if(n<0){return 1;}progress|=n;
        n=process_lane(data,0);if(n<0){return 1;}progress|=n;
        if(framer->control_expected&&framer->control_used==framer->control_expected) {
            used=0;n=tcp_framer_control(framer,actor,NULL,0,&used);
            if(n<0){return 1;}progress|=n;
        }
        if(framer->expected&&framer->used==framer->expected) {
            used=0;n=tcp_framer_feed(framer,actor,NULL,0,&used);
            if(n<0){return 1;}progress|=n;
        }
        n=tcp_framer_poll_listener(framer,actor);if(n<0){return 1;}progress|=n;
        for(unsigned i=0;i<actor->owner.limit;i++) {
            struct tcp_accept_slot *slot=&actor->owner.slots[i];sync_child(i);
            if(slot->socket==TCP_ACCEPT_INVALID||slot->poisoned)continue;
            struct child_state *c=&children[i];
            if(c->retry_ms&&now<c->retry_ms)continue;
            c->retry_ms=0;
            if(c->error) {
                n=tcp_framer_fail_child(framer,actor,slot->child,slot->permit,c->error);
                if(n<0){return 1;}progress|=n;continue;
            }
            if(actor->flows[i].count) {
                n=TCP_POSIX_FLUSH(actor,slot->child,slot->permit);
                if(n==-2){c->error=actor->native_error;progress=1;continue;}
                if(n<0){return 1;}
                if(n==0&&c->hangup){c->retry_ms=now+HUP_RETRY_MS;continue;}
                progress|=n;
            }
            n=tcp_actor_receive_child(actor,slot->child,slot->permit);
            if(n==-2){c->error=actor->native_error;progress=1;continue;}
            if(n<0){return 1;}progress|=n;
        }
        n=write_output();if(n<0){return 1;}progress|=n;
        if(framer->exit_requested&&!actor->out_count&&!framer->output_offset&&
           !framer->used&&!framer->control_used&&!data->length&&!control->length)return 0;
        if(progress)continue;
        struct pollfd pfds[TCP_ACCEPT_MAX+4];int kind[TCP_ACCEPT_MAX+4];unsigned count=0;
        int timeout=-1;
#define ADD(fd_,ev_,kind_) do {pfds[count]=(struct pollfd){(fd_),(ev_),0};kind[count++]=(kind_);} while(0)
        if(!control->length)ADD(control->fd,POLLIN,-1);
        if(!data->length)ADD(data->fd,POLLIN,-2);
        if(tcp_actor_peek(actor))ADD(STDOUT_FILENO,POLLOUT,-3);
        if(actor->owner.listener!=TCP_ACCEPT_INVALID&&!actor->need&&capacity()&&
           actor->out_count<TCP_ACTOR_NORMAL_OUTPUTS) {
            int free_slot=0;
            for(unsigned i=0;i<actor->owner.limit;i++)if(actor->owner.slots[i].socket==TCP_ACCEPT_INVALID)free_slot=1;
            if(free_slot)ADD(actor->owner.listener,POLLIN,-4);
        }
        if(actor->out_count<TCP_ACTOR_NORMAL_OUTPUTS)for(unsigned i=0;i<actor->owner.limit;i++) {
            struct tcp_accept_slot *slot=&actor->owner.slots[i];struct tcp_accept_flow *flow=&actor->flows[i];
            if(slot->socket==TCP_ACCEPT_INVALID||slot->poisoned||children[i].error)continue;
            if(children[i].retry_ms&&now<children[i].retry_ms) {
                int delay=(int)(children[i].retry_ms-now);
                if(timeout<0||delay<timeout)timeout=delay;
                continue;
            }
            short events=0;
            if(flow->credit&&!flow->read_eof)events|=POLLIN|POLLPRI;
            if(flow->count)events|=POLLOUT;
            if(!events&&children[i].hangup)continue;
            ADD(slot->socket,events,(int)i);
        }
#undef ADD
        n=TCP_POSIX_POLL(pfds,count,timeout);if(n<0){if(errno==EINTR)continue;return 1;}
        for(unsigned j=0;j<count;j++) {
            short re=pfds[j].revents;if(!re)continue;
            if(kind[j]==-1||kind[j]==-2) {
                if(re&(POLLERR|POLLNVAL))return 1;
                if(re&(POLLIN|POLLHUP)) {
                    n=read_lane(kind[j]==-1?control:data);if(n<0)return 1;
                }
            } else if(kind[j]==-3) {
                if(re&(POLLERR|POLLHUP|POLLNVAL))return 1;
            } else if(kind[j]==-4) {
                if(re&(POLLERR|POLLHUP|POLLNVAL))return 1;
            } else {
                unsigned i=(unsigned)kind[j];sync_child(i);
                if(re&POLLNVAL)return 1;
                if(re&POLLERR) {
                    int error=0;socklen_t len=sizeof(error);
                    if(getsockopt(pfds[j].fd,SOL_SOCKET,SO_ERROR,&error,&len)!=0)return 1;
                    if(error)children[i].error=error;
                }
                if(re&POLLHUP)children[i].hangup=1;
            }
        }
    }
}
int main(int argc,char **argv) {
    uint32_t port,limit,epoch,control,acl[32];unsigned acl_count;
    if(argc!=7||!parse_u32(argv[2],&port)||port>65535||
       !parse_u32(argv[4],&limit)||!limit||limit>TCP_ACCEPT_MAX||
       !parse_u32(argv[5],&epoch)||!epoch||!parse_u32(argv[6],&control)||
       control<3||control>INT_MAX)return 2;
    if(!parse_acl(argv[3],acl,&acl_count))return 2;
    if(!nonblock(STDIN_FILENO)||!nonblock(STDOUT_FILENO)||!nonblock((int)control))return 2;
    signal(SIGPIPE,SIG_IGN);
    actor=calloc(1,sizeof(*actor));framer=calloc(1,sizeof(*framer));if(!actor||!framer)return 2;
    if(!tcp_actor_init(actor,epoch,argv[1],(uint16_t)port,acl,acl_count,limit))return 2;
    struct lane data={STDIN_FILENO,0,{0}},ctrl={(int)control,0,{0}};
    int result=run(&data,&ctrl);
    if(actor->native_error)fprintf(stderr,"tcp-accept native error: %d\n",actor->native_error);
    (void)tcp_actor_abort(actor);
    /* A close error is ambiguous; process exit is the ownership barrier. */
    free(framer);free(actor);return result;
}
#else
#include <stdio.h>
int main(void){fputs("POSIX process wrapper is unavailable on Windows\n",stderr);return 2;}
#endif
