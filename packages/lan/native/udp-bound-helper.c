/* SPDX-License-Identifier: Apache-2.0
 * Ordinary bound UDP backend. One process owns one unconnected native socket.
 * The parent authorizes every numeric peer before PEER admission. Scope-bearing,
 * multicast and mixed-family endpoints are outside this backend's capabilities.
 * stdout contains only versioned protocol records; stderr is diagnostic.
 */
#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#ifdef _WIN32
#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET 0x9800000c
#endif
typedef SOCKET NativeSocket;
typedef int SockLen;
#define BAD_SOCKET INVALID_SOCKET
#define close_socket closesocket
typedef CRITICAL_SECTION Mutex;
typedef CONDITION_VARIABLE Condition;
typedef HANDLE Thread;
#else
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <linux/errqueue.h>
#include <unistd.h>
#include <fcntl.h>
#include <pthread.h>
#include <poll.h>
#include <errno.h>
#include <time.h>
#include <signal.h>
typedef int NativeSocket;
typedef socklen_t SockLen;
#define BAD_SOCKET (-1)
#define close_socket close
typedef pthread_mutex_t Mutex;
typedef pthread_cond_t Condition;
typedef pthread_t Thread;
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#ifdef UDP_TEST_CLOCK
#include <stdatomic.h>
static _Atomic uint32_t clock_advance=0;
#endif

enum { HEADER=16, ADDR=24, TX_CAP=256, BYTE_CAP=262144, RX_CAP=256,
       CTRL_CAP=64, ERROR_CAP=32, PEER_CAP=128, MAX_DATA=65527, MAX_FRAME=HEADER+8+MAX_DATA };
enum { BIND=1, PEER=2, SEND=3, CREDIT=4, RETIRE=5, CLOSE=6, STATUS=7, ABORT=10,
       READY=101, PEER_READY=102, SEND_RESULT=103, CREDIT_APPLIED=104,
       RETIRED=105, CLOSED=106, RX=107, PEER_ERROR=108, DROPPED=109, FAIL=110, SNAPSHOT=111, CONTROL_CANCELLED=114 };
enum { FREE=0, PENDING=1, DONE=2 };
typedef struct { uint8_t bytes[ADDR]; } Address;
typedef struct { int used,live; uint32_t id,epoch; Address address; uint64_t retire_sequence; } Peer;
typedef struct {
    int state; uint32_t id,peer,epoch,length; uint64_t sequence,deadline;
    Address address; uint8_t *data; uint32_t status,wsa,native_error,attempts;
} Tx;
typedef struct { int used; uint8_t opcode; uint32_t id,length; uint64_t sequence; uint8_t body[96]; } Control;
typedef struct { int used; uint32_t peer,epoch,length; Address address; uint8_t *data; uint64_t sequence; } Received;
typedef struct { int used; uint32_t peer,epoch,wsa,native_error,origin,type,code,count; Address address; } Error;
static Mutex mutex;
static Condition output_ready;
static NativeSocket native_socket=BAD_SOCKET;
static Peer peers[PEER_CAP];
static Tx tx[TX_CAP];
static Control input[CTRL_CAP], output[CTRL_CAP];
static Received rx[RX_CAP];
static Error errors[ERROR_CAP];
static uint32_t last_tx_id=0;
static uint32_t generation=0,tx_count=0,tx_bytes=0,rx_count=0,rx_bytes=0,rx_credit_bytes=0,rx_credit_packets=0;
static uint64_t sequence=0,accepted=0,rejected=0,received_count=0,drop_packets=0,drop_bytes=0,reported_drop_packets=0,reported_drop_bytes=0;
static uint64_t error_drops=0,unattributed_errors=0,reported_error_drops=0,reported_unattributed_errors=0;
static int bind_pending=0,bound=0,closing=0,aborting=0,native_closed=0,reader_finished=0,writer_finished=0,fatal=0,fatal_reported=0,writer_failed=0;
static uint32_t close_id=0,fatal_code=0;
static uint64_t close_sequence=UINT64_MAX;
static Address self_address;
#ifdef UDP_TEST_RACE
static uint32_t inject_peer=0;
static Address inject_address;
#endif
#ifdef _WIN32
static HANDLE input_event;
static WSAEVENT socket_event=WSA_INVALID_EVENT;
static void lock(void){EnterCriticalSection(&mutex);}
static void unlock(void){LeaveCriticalSection(&mutex);}
static void signal_output(void){WakeConditionVariable(&output_ready);}
static void wait_output(void){SleepConditionVariableCS(&output_ready,&mutex,INFINITE);}
static void wake_main(void){SetEvent(input_event);}
static uint64_t native_millis(void){return GetTickCount64();}
static int socket_error(void){return WSAGetLastError();}
static int would_block(int e){return e==WSAEWOULDBLOCK;}
#else
static int wake_pipe[2];
static void lock(void){pthread_mutex_lock(&mutex);}
static void unlock(void){pthread_mutex_unlock(&mutex);}
static void signal_output(void){pthread_cond_signal(&output_ready);}
static void wait_output(void){pthread_cond_wait(&output_ready,&mutex);}
static void wake_main(void){uint8_t byte=1;ssize_t n=write(wake_pipe[1],&byte,1);(void)n;}
static uint64_t native_millis(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000;}
static int socket_error(void){return errno;}
static int would_block(int e){return e==EAGAIN||e==EWOULDBLOCK;}
#endif
static uint64_t millis(void){
#ifdef UDP_TEST_CLOCK
    return native_millis()+atomic_load(&clock_advance);
#else
    return native_millis();
#endif
}
static uint32_t u32(const uint8_t *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static void put32(uint8_t *p,uint32_t n){p[0]=(uint8_t)n;p[1]=(uint8_t)(n>>8);p[2]=(uint8_t)(n>>16);p[3]=(uint8_t)(n>>24);}
static void put64(uint8_t *p,uint64_t n){put32(p,(uint32_t)n);put32(p+4,(uint32_t)(n>>32));}
static int same_address(const Address *a,const Address *b){return memcmp(a->bytes,b->bytes,ADDR)==0;}
static int valid_address(const Address *a,int local){
    const uint8_t *p=a->bytes;int i,zero=1;
    if(p[1]||(!local&&!p[2]&&!p[3])||u32(p+4))return 0;
    if(p[0]==4){
        for(i=12;i<24;i++)if(p[i])return 0;
        for(i=8;i<12;i++)if(p[i])zero=0;
        /* IPv4 multicast/broadcast have a separate membership/policy contract. */
        if(p[8]>=224)return 0;
        return local||!zero;
    }
    if(p[0]==6){
        if(p[8]==255||(p[8]==254&&(p[9]&192)==128))return 0;
        for(i=8;i<24;i++)if(p[i])zero=0;
        if(!local&&zero)return 0;
        for(i=8;i<18;i++)if(p[i])return 1;
        /* Do not silently reinterpret IPv4-mapped endpoints on a V6ONLY socket. */
        return !(p[18]==255&&p[19]==255);
    }
    return 0;
}
static int to_native(const Address *a,struct sockaddr_storage *storage){
    memset(storage,0,sizeof(*storage));
    if(a->bytes[0]==4){
        struct sockaddr_in *s=(struct sockaddr_in*)storage;s->sin_family=AF_INET;
        memcpy(&s->sin_port,a->bytes+2,2);memcpy(&s->sin_addr,a->bytes+8,4);return (int)sizeof(*s);
    }else{
        struct sockaddr_in6 *s=(struct sockaddr_in6*)storage;s->sin6_family=AF_INET6;
        memcpy(&s->sin6_port,a->bytes+2,2);memcpy(&s->sin6_addr,a->bytes+8,16);s->sin6_scope_id=u32(a->bytes+4);return (int)sizeof(*s);
    }
}
static int from_native(Address *a,const struct sockaddr_storage *s,SockLen length){
    memset(a,0,sizeof(*a));
    if(s->ss_family==AF_INET&&length>=(SockLen)sizeof(struct sockaddr_in)){
        const struct sockaddr_in *p=(const struct sockaddr_in*)s;
        a->bytes[0]=4;memcpy(a->bytes+2,&p->sin_port,2);memcpy(a->bytes+8,&p->sin_addr,4);
    }else if(s->ss_family==AF_INET6&&length>=(SockLen)sizeof(struct sockaddr_in6)){
        const struct sockaddr_in6 *p=(const struct sockaddr_in6*)s;
        a->bytes[0]=6;memcpy(a->bytes+2,&p->sin6_port,2);put32(a->bytes+4,p->sin6_scope_id);memcpy(a->bytes+8,&p->sin6_addr,16);
    }else return 0;
    return valid_address(a,1)&&(a->bytes[2]||a->bytes[3]);
}
static Peer *peer_id(uint32_t id){int i;for(i=0;i<PEER_CAP;i++)if(peers[i].used&&peers[i].id==id)return &peers[i];return NULL;}
static Peer *peer_address(const Address *a){int i;for(i=0;i<PEER_CAP;i++)if(peers[i].used&&same_address(&peers[i].address,a))return &peers[i];return NULL;}
static int live_peer(uint32_t id,uint32_t epoch){Peer *p=peer_id(id);return p&&p->live&&p->epoch==epoch;}
static void fail_locked(uint32_t code){if(!fatal){fatal=1;fatal_code=code;}closing=1;signal_output();wake_main();}
static int free_control(Control *queue){int i;for(i=0;i<CTRL_CAP;i++)if(!queue[i].used)return i;return -1;}
static void output_locked(uint8_t opcode,uint32_t id,const void *body,uint32_t length){
    int i=free_control(output);
    if(i<0||length>sizeof(output[0].body)){fail_locked(10055);return;}
    output[i].used=1;output[i].opcode=opcode;output[i].id=id;output[i].length=length;output[i].sequence=++sequence;
    if(length)memcpy(output[i].body,body,length);
    signal_output();
}
static void result_body(uint8_t *b,const Tx *t){
    put32(b,t->peer);put32(b+4,t->epoch);put32(b+8,t->status);put32(b+12,t->wsa);put32(b+16,t->native_error);put32(b+20,t->attempts);
}
static void reject_locked(uint32_t id,uint32_t peer,uint32_t epoch,uint32_t code){
    uint8_t b[24]={0};put32(b,peer);put32(b+4,epoch);put32(b+8,1);put32(b+12,code);rejected++;output_locked(SEND_RESULT,id,b,sizeof(b));
}
static int read_exact(uint8_t *p,size_t length){
    while(length){
#ifdef _WIN32
        int n=_read(0,p,(unsigned int)length);
#else
        int old_cancel;ssize_t n;
        pthread_setcancelstate(PTHREAD_CANCEL_ENABLE,&old_cancel);
        n=read(0,p,length);
        pthread_setcancelstate(old_cancel,NULL);
        if(n<0&&errno==EINTR)continue;
#endif
        if(n<=0)return 0;
        p+=n;length-=(size_t)n;
    }return 1;
}
#ifdef _WIN32
static DWORD WINAPI input_thread(LPVOID unused)
#else
static void *input_thread(void *unused)
#endif
{
    uint8_t header[HEADER],body[8+MAX_DATA];(void)unused;
#ifndef _WIN32
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,NULL);
#endif
    for(;;){
        uint32_t total,length,id,gen;uint8_t op;int i;
        if(!read_exact(header,HEADER))break;
        total=u32(header);op=header[5];id=u32(header+8);gen=u32(header+12);
        if(total<HEADER||total>MAX_FRAME||header[4]!=1||header[6]||header[7]){
            lock();fail_locked(10022);unlock();break;
        }
        length=total-HEADER;
        if(!read_exact(body,length)){lock();fail_locked(10022);unlock();break;}
        lock();
        if(fatal){unlock();break;}
        if(op==SEND){
            uint32_t pid=length>=8?u32(body):0,epoch=length>=8?u32(body+4):0;Peer *p=peer_id(pid);
            if(!id||id<=last_tx_id){fail_locked(10022);unlock();break;}
            last_tx_id=id;
            if(!bound||gen!=generation||length<8||!p||!p->live||p->retire_sequence||p->epoch!=epoch)reject_locked(id,pid,epoch,10013);
            else if(closing)reject_locked(id,pid,epoch,10058);
            else if(length-8>(self_address.bytes[0]==4?65507u:65527u))reject_locked(id,pid,epoch,10040);
            else if(tx_count==TX_CAP||length-8>BYTE_CAP-tx_bytes)reject_locked(id,pid,epoch,10055);
            else{
                for(i=0;i<TX_CAP;i++)if(tx[i].state==FREE)break;
                if(i==TX_CAP){fail_locked(10055);unlock();break;}
                tx[i].data=malloc(length>8?length-8:1);
                if(!tx[i].data){fail_locked(10055);unlock();break;}
                tx[i].state=PENDING;tx[i].id=id;tx[i].peer=pid;tx[i].epoch=epoch;tx[i].length=length-8;
                tx[i].address=p->address;tx[i].sequence=++sequence;tx[i].deadline=millis()+3000;
                tx[i].status=tx[i].wsa=tx[i].native_error=tx[i].attempts=0;
                if(length>8)memcpy(tx[i].data,body+8,length-8);
                tx_count++;tx_bytes+=length-8;
            }
        }else if((op==CLOSE||op==ABORT)&&length==0&&gen==generation&&bind_pending){
            if(op==ABORT){aborting=1;closing=1;close_id=id;close_sequence=++sequence;}
            else if(!closing){closing=1;close_id=id;close_sequence=++sequence;}
        }else{
            if(op==BIND){
                if(bind_pending||closing||!gen||length!=ADDR){fail_locked(10022);unlock();break;}
                bind_pending=1;generation=gen;
            }else if(gen!=generation||!bind_pending||closing){
                fail_locked(10022);unlock();break;
            }
            if(length>96||free_control(input)<0){fail_locked(10055);unlock();break;}
            i=free_control(input);
            input[i].used=1;input[i].opcode=op;input[i].id=id;input[i].length=length;input[i].sequence=++sequence;
            if(length)memcpy(input[i].body,body,length);
            if(op==RETIRE&&length==8){
                Peer *p=peer_id(u32(body));
                if(p&&p->live&&p->epoch==u32(body+4))p->retire_sequence=input[i].sequence;
            }
        }
        signal_output();wake_main();unlock();
    }
    lock();reader_finished=1;if(!closing){closing=1;close_id=0;close_sequence=++sequence;}wake_main();signal_output();unlock();
#ifdef _WIN32
    return 0;
#else
    return NULL;
#endif
}
static int write_exact(const uint8_t *p,size_t length){
    while(length){
#ifdef _WIN32
        int n=_write(1,p,(unsigned int)(length>4096?4096:length));
#else
        ssize_t n=write(1,p,length);if(n<0&&errno==EINTR)continue;
#endif
        if(n<=0)return 0;
        p+=n;length-=(size_t)n;
    }return 1;
}
static int first_control(Control *q){
    int i,best=-1;for(i=0;i<CTRL_CAP;i++)if(q[i].used&&(best<0||q[i].sequence<q[best].sequence))best=i;return best;
}
#ifdef _WIN32
static DWORD WINAPI output_thread(LPVOID unused)
#else
static void *output_thread(void *unused)
#endif
{
    uint8_t frame[MAX_FRAME+128];(void)unused;
    for(;;){
        uint8_t op=0;uint32_t id=0,length=0;int i,tx_index=-1,control_index=-1,stop=0;
        lock();
        for(;;){
            for(i=0;i<CTRL_CAP;i++)if(input[i].used==DONE&&(control_index<0||input[i].sequence<input[control_index].sequence))control_index=i;
            if(control_index>=0){
                Control *command=&input[control_index];op=command->opcode;id=command->id;length=command->length;memcpy(frame+HEADER,command->body,length);break;
            }
            i=first_control(output);
            if(i>=0){op=output[i].opcode;id=output[i].id;length=output[i].length;memcpy(frame+HEADER,output[i].body,length);output[i].used=0;break;}
            if(fatal&&!fatal_reported){op=FAIL;put32(frame+HEADER,fatal_code);length=4;fatal_reported=1;break;}
            for(i=0;i<TX_CAP;i++)if(tx[i].state==DONE){tx_index=i;break;}
            if(tx_index>=0){op=SEND_RESULT;id=tx[tx_index].id;length=24;result_body(frame+HEADER,&tx[tx_index]);break;}
            for(i=0;i<ERROR_CAP;i++)if(errors[i].used){
                Error *e=&errors[i];
                if(!live_peer(e->peer,e->epoch)){e->used=0;continue;}
                op=PEER_ERROR;put32(frame+HEADER,e->peer);put32(frame+HEADER+4,e->epoch);
                memcpy(frame+HEADER+8,e->address.bytes,ADDR);
                put32(frame+HEADER+32,e->wsa);put32(frame+HEADER+36,e->native_error);
                put32(frame+HEADER+40,e->origin);put32(frame+HEADER+44,e->type);put32(frame+HEADER+48,e->code);put32(frame+HEADER+52,e->count);
                length=56;e->used=0;break;
            }
            if(op)break;
            if(drop_packets!=reported_drop_packets||error_drops!=reported_error_drops||unattributed_errors!=reported_unattributed_errors){
                op=DROPPED;put64(frame+HEADER,drop_packets);put64(frame+HEADER+8,drop_bytes);put64(frame+HEADER+16,error_drops);put64(frame+HEADER+24,unattributed_errors);length=32;
                reported_drop_packets=drop_packets;reported_drop_bytes=drop_bytes;
                reported_error_drops=error_drops;reported_unattributed_errors=unattributed_errors;break;
            }
            {
                int oldest=-1;
                for(i=0;i<RX_CAP;i++)if(rx[i].used){
                    Received *r=&rx[i];
                    if(!live_peer(r->peer,r->epoch)){rx_count--;rx_bytes-=r->length;free(r->data);r->used=0;continue;}
                    if(oldest<0||r->sequence<rx[oldest].sequence)oldest=i;
                }
                if(oldest>=0&&rx_credit_packets&&rx[oldest].length<=rx_credit_bytes){
                    Received *r=&rx[oldest];
                    op=RX;put32(frame+HEADER,r->peer);put32(frame+HEADER+4,r->epoch);
                    memcpy(frame+HEADER+8,r->address.bytes,ADDR);if(r->length)memcpy(frame+HEADER+32,r->data,r->length);
                    length=32+r->length;rx_credit_packets--;rx_credit_bytes-=r->length;
                    rx_count--;rx_bytes-=r->length;free(r->data);r->used=0;
                }
            }
            if(op)break;
            if(native_closed&&tx_count==0&&first_control(input)<0){
                op=CLOSED;id=close_id;length=88;
                put64(frame+HEADER,accepted);put64(frame+HEADER+8,rejected);put64(frame+HEADER+16,received_count);
                put64(frame+HEADER+24,drop_packets);put64(frame+HEADER+32,drop_bytes);
                memcpy(frame+HEADER+40,self_address.bytes,ADDR);put32(frame+HEADER+64,(uint32_t)aborting);
                put64(frame+HEADER+68,error_drops);put64(frame+HEADER+76,unattributed_errors);put32(frame+HEADER+84,fatal?fatal_code:0);stop=1;break;
            }
            wait_output();
        }
        put32(frame,HEADER+length);frame[4]=1;frame[5]=op;frame[6]=frame[7]=0;put32(frame+8,id);put32(frame+12,generation);
        unlock();
        if(!write_exact(frame,HEADER+length)){
            lock();writer_failed=1;fail_locked(10050);writer_finished=1;wake_main();unlock();break;
        }
        lock();
        if(control_index>=0)input[control_index].used=0;
        if(tx_index>=0){
            tx_bytes-=tx[tx_index].length;tx_count--;free(tx[tx_index].data);memset(&tx[tx_index],0,sizeof(tx[tx_index]));
        }
        if(stop)writer_finished=1;
        wake_main();unlock();
        if(stop)break;
    }
#ifdef _WIN32
    return 0;
#else
    return NULL;
#endif
}
static void record_error(const Address *address,uint32_t wsa,uint32_t native_error,uint32_t origin,uint32_t type,uint32_t code){
    Peer *p;int i,free_index=-1;
    lock();p=peer_address(address);
    if(!p||!p->live){unattributed_errors++;signal_output();unlock();return;}
    for(i=0;i<ERROR_CAP;i++){
        Error *e=&errors[i];
        if(!e->used){if(free_index<0)free_index=i;continue;}
        if(e->peer==p->id&&e->epoch==p->epoch&&e->wsa==wsa&&e->native_error==native_error&&e->origin==origin&&e->type==type&&e->code==code){
            if(e->count!=UINT32_MAX)e->count++;
            signal_output();unlock();return;
        }
    }
    if(free_index<0){error_drops++;signal_output();unlock();return;}
    errors[free_index]=(Error){1,p->id,p->epoch,wsa,native_error,origin,type,code,1,*address};signal_output();unlock();
}
static void record_rx(const Address *address,const uint8_t *data,uint32_t length){
    Peer *p;int i;uint8_t *copy;
    lock();p=peer_address(address);
    if(!p||!p->live||rx_count==RX_CAP||length>BYTE_CAP-rx_bytes){
        drop_packets++;drop_bytes+=length;signal_output();unlock();return;
    }
    copy=malloc(length?length:1);
    if(!copy){drop_packets++;drop_bytes+=length;signal_output();unlock();return;}
    if(length)memcpy(copy,data,length);
    for(i=0;i<RX_CAP;i++)if(!rx[i].used)break;
    rx[i]=(Received){1,p->id,p->epoch,length,*address,copy,++sequence};rx_count++;rx_bytes+=length;received_count++;signal_output();unlock();
}
#ifndef _WIN32
static int drain_errors(void){
    int count=0,turn;
    for(turn=0;turn<32;turn++){
        uint8_t quote[32],control[512];struct sockaddr_storage name;struct iovec vector;
        struct msghdr msg;struct cmsghdr *c;Address address;ssize_t n;
        memset(&msg,0,sizeof(msg));memset(&name,0,sizeof(name));
        vector.iov_base=quote;vector.iov_len=sizeof(quote);msg.msg_name=&name;msg.msg_namelen=sizeof(name);
        msg.msg_iov=&vector;msg.msg_iovlen=1;msg.msg_control=control;msg.msg_controllen=sizeof(control);
        n=recvmsg(native_socket,&msg,MSG_ERRQUEUE|MSG_DONTWAIT);
        if(n<0){if(errno==EINTR){turn--;continue;}break;}
        count++;
        if((msg.msg_flags&MSG_CTRUNC)||!from_native(&address,&name,msg.msg_namelen))continue;
        for(c=CMSG_FIRSTHDR(&msg);c;c=CMSG_NXTHDR(&msg,c)){
            struct sock_extended_err value;uint32_t mapped=0;
            if(!((c->cmsg_level==IPPROTO_IP&&c->cmsg_type==IP_RECVERR)||(c->cmsg_level==IPPROTO_IPV6&&c->cmsg_type==IPV6_RECVERR)))continue;
            if(c->cmsg_len<CMSG_LEN(sizeof(value)))continue;
            memcpy(&value,CMSG_DATA(c),sizeof(value));
            if(value.ee_errno==ECONNREFUSED&&
               ((value.ee_origin==SO_EE_ORIGIN_ICMP&&value.ee_type==3&&value.ee_code==3)||
                (value.ee_origin==SO_EE_ORIGIN_ICMP6&&value.ee_type==1&&value.ee_code==4)))mapped=10054;
            record_error(&address,mapped,value.ee_errno,value.ee_origin,value.ee_type,value.ee_code);
        }
    }
    return count;
}
#else
static int drain_errors(void){return 0;}
#endif
static void receive_datagrams(void){
    int turn;uint8_t data[MAX_DATA+1];
    for(turn=0;turn<32;turn++){
        struct sockaddr_storage name;SockLen length=sizeof(name);Address address;int n,e;
        memset(&name,0,sizeof(name));
        n=(int)recvfrom(native_socket,(char*)data,sizeof(data),0,(struct sockaddr*)&name,&length);
        if(n>=0){
            if(from_native(&address,&name,length))record_rx(&address,data,(uint32_t)n);
            continue;
        }
        e=socket_error();if(would_block(e))break;
#ifdef _WIN32
        if(e==WSAECONNRESET){
            if(from_native(&address,&name,length))record_error(&address,10054,10054,0,0,0);
            continue;
        }
        if(e==WSAEMSGSIZE){lock();drop_packets++;signal_output();unlock();continue;}
#else
        if(e==EINTR){turn--;continue;}
        if(e==ECONNREFUSED||e==EHOSTUNREACH||e==ENETUNREACH){(void)drain_errors();continue;}
#endif
        break;
    }
}
static uint32_t local_error(int e){
#ifdef _WIN32
    return (uint32_t)e;
#else
    switch(e){
        case EINVAL:return 10022;case EMSGSIZE:return 10040;case ENOBUFS:return 10055;
        case EACCES:case EPERM:return 10013;case EADDRINUSE:return 10048;case EADDRNOTAVAIL:return 10049;
        case EBADF:return 10038;default:return 0;
    }
#endif
}
static int open_bound(const Address *address){
    struct sockaddr_storage name;int length=to_native(address,&name),one=1;SockLen actual=sizeof(name);
    native_socket=socket(address->bytes[0]==4?AF_INET:AF_INET6,SOCK_DGRAM,IPPROTO_UDP);
    if(native_socket==BAD_SOCKET)return socket_error();
    if(address->bytes[0]==6&&setsockopt(native_socket,IPPROTO_IPV6,IPV6_V6ONLY,(const char*)&one,sizeof(one))!=0)return socket_error();
#ifdef _WIN32
    {
        BOOL reset=TRUE;DWORD returned=0;
        if(WSAIoctl(native_socket,SIO_UDP_CONNRESET,&reset,sizeof(reset),NULL,0,&returned,NULL,NULL)==SOCKET_ERROR)return socket_error();
        socket_event=WSACreateEvent();
        if(socket_event==WSA_INVALID_EVENT)return socket_error();
        if(WSAEventSelect(native_socket,socket_event,FD_READ|FD_WRITE|FD_CLOSE)!=0)return socket_error();
    }
#else
    if(fcntl(native_socket,F_SETFL,O_NONBLOCK)<0)return errno;
    if(setsockopt(native_socket,address->bytes[0]==4?IPPROTO_IP:IPPROTO_IPV6,
                  address->bytes[0]==4?IP_RECVERR:IPV6_RECVERR,&one,sizeof(one))!=0)return errno;
#endif
    if(bind(native_socket,(struct sockaddr*)&name,(SockLen)length)!=0)return socket_error();
    if(getsockname(native_socket,(struct sockaddr*)&name,&actual)!=0)return socket_error();
    if(!from_native(&self_address,&name,actual))return 10022;
    return 0;
}
static uint64_t minimum_tx_sequence(void){
    int i;uint64_t best=UINT64_MAX;
    for(i=0;i<TX_CAP;i++)if(tx[i].state==PENDING&&tx[i].sequence<best)best=tx[i].sequence;
    return best;
}
static void reply_control_locked(int index,uint8_t opcode,uint32_t id,const void *body,uint32_t length){
    input[index].opcode=opcode;input[index].id=id;input[index].length=length;
    if(length)memcpy(input[index].body,body,length);
    input[index].used=DONE;signal_output();
}
static int prior_control_pending(void){
    int i;for(i=0;i<CTRL_CAP;i++)if(input[i].used==PENDING&&input[i].sequence<close_sequence)return 1;return 0;
}
static int process_control(void){
    Control command;int i,best=-1;uint64_t pending;uint8_t reply[96]={0};
    lock();
    pending=minimum_tx_sequence();
    for(i=0;i<CTRL_CAP;i++)if(input[i].used==PENDING){
        if(input[i].opcode!=CREDIT&&input[i].opcode!=STATUS&&input[i].sequence>pending)continue;
        if(best<0||input[i].sequence<input[best].sequence)best=i;
    }
    if(best<0){unlock();return 0;}
    command=input[best];
    if(aborting){
        put32(reply,command.opcode);put32(reply+4,10004);reply_control_locked(best,CONTROL_CANCELLED,command.id,reply,8);unlock();return 1;
    }
    if(fatal){
        put32(reply,fatal_code);reply_control_locked(best,FAIL,command.id,reply,4);unlock();return 1;
    }
    if(command.opcode==CREDIT&&command.length==8&&bound){
        uint32_t bytes=u32(command.body),packets=u32(command.body+4);
        if(bytes>BYTE_CAP-rx_credit_bytes||packets>RX_CAP-rx_credit_packets){fail_locked(10055);unlock();return 1;}
        rx_credit_bytes+=bytes;rx_credit_packets+=packets;
        put32(reply,rx_credit_bytes);put32(reply+4,rx_credit_packets);
        reply_control_locked(best,CREDIT_APPLIED,command.id,reply,8);
    }else if(command.opcode==BIND&&command.length==ADDR&&!bound){
        Address address;int error;memcpy(address.bytes,command.body,ADDR);
        if(!valid_address(&address,1)){fail_locked(10013);unlock();return 1;}
        unlock();error=open_bound(&address);lock();
        if(error){fail_locked(local_error(error));unlock();return 1;}
        bound=1;memcpy(reply,self_address.bytes,ADDR);put32(reply+24,0x3f);
        put32(reply+28,TX_CAP);put32(reply+32,BYTE_CAP);put32(reply+36,RX_CAP);put32(reply+40,CTRL_CAP);put32(reply+44,PEER_CAP);
        reply_control_locked(best,READY,command.id,reply,48);
    }else if(command.opcode==PEER&&command.length==8+ADDR&&bound){
        uint32_t id=u32(command.body),epoch=u32(command.body+4),error=0;Address address;Peer *p,*owner;
        memcpy(address.bytes,command.body+8,ADDR);p=peer_id(id);owner=peer_address(&address);
        if(!id||!epoch||!valid_address(&address,0)||address.bytes[0]!=self_address.bytes[0])error=10013;
        else if(owner&&owner->id!=id)error=10048;
        else if(p&&(!same_address(&p->address,&address)||epoch<=p->epoch))error=10022;
        else{
            if(!p){for(i=0;i<PEER_CAP;i++)if(!peers[i].used){p=&peers[i];break;}}
            if(!p)error=10055;else *p=(Peer){1,1,id,epoch,address,0};
        }
        put32(reply,id);put32(reply+4,epoch);put32(reply+8,error);reply_control_locked(best,PEER_READY,command.id,reply,12);
    }else if(command.opcode==RETIRE&&command.length==8&&bound){
        uint32_t id=u32(command.body),epoch=u32(command.body+4),error=0;Peer *p=peer_id(id);
        if(!p||!p->live||p->epoch!=epoch)error=10013;else p->live=0;
        put32(reply,id);put32(reply+4,epoch);put32(reply+8,error);reply_control_locked(best,RETIRED,command.id,reply,12);
    }else if(command.opcode==250&&command.length==4){
#ifdef UDP_TEST_CLOCK
        atomic_fetch_add(&clock_advance,u32(command.body));
        reply_control_locked(best,251,command.id,command.body,4);
#else
        fail_locked(10045);
#endif
    }else if(command.opcode==8&&command.length==12){
#ifdef UDP_TEST_RACE
        Peer *a=peer_id(u32(command.body)),*b=peer_id(u32(command.body+8));
        if(!a||!b||!a->live||!b->live||a->epoch!=u32(command.body+4)){fail_locked(10013);unlock();return 1;}
        inject_address=a->address;inject_peer=b->id;
        reply_control_locked(best,112,command.id,command.body,12);
#else
        fail_locked(10045);
#endif
    }else if((command.opcode==STATUS||command.opcode==9)&&command.length==0){
        put32(reply,tx_count);put32(reply+4,tx_bytes);put32(reply+8,rx_count);put32(reply+12,rx_bytes);
        put32(reply+16,rx_credit_bytes);put32(reply+20,rx_credit_packets);put64(reply+24,accepted);put64(reply+32,rejected);
        {
            uint32_t ec=0,cc=0,pc=0;
            for(i=0;i<ERROR_CAP;i++)if(errors[i].used)ec++;
            for(i=0;i<CTRL_CAP;i++)if(input[i].used){cc++;if(input[i].used==PENDING)pc++;}
            put32(reply+40,ec);put32(reply+44,cc);put32(reply+48,pc);put32(reply+52,(uint32_t)native_closed);
        }
        reply_control_locked(best,SNAPSHOT,command.id,reply,56);
    }else if(command.opcode==CLOSE&&command.length==0){
        closing=1;close_id=command.id;
    }else fail_locked(10022);
    unlock();return 1;
}
static int send_one(void){
    int i,best=-1,n,e;Tx *packet;struct sockaddr_storage name;int length;
#ifdef UDP_TEST_RACE
    int inject=0,trigger_result=0,readiness=0;
#endif
    lock();
    for(i=0;i<TX_CAP;i++)if(tx[i].state==PENDING&&(best<0||tx[i].sequence<tx[best].sequence))best=i;
    if(best<0){unlock();return 0;}
    packet=&tx[best];
    if(aborting){
        packet->status=2;packet->wsa=10004;packet->state=DONE;signal_output();unlock();return 1;
    }
    if(fatal){
        packet->status=2;packet->wsa=fatal_code;packet->state=DONE;signal_output();unlock();return 1;
    }
    for(i=0;i<CTRL_CAP;i++){
        if(input[i].used==PENDING&&input[i].opcode!=CREDIT&&input[i].opcode!=STATUS&&input[i].sequence<tx[best].sequence){
            unlock();return 0;
        }
    }
    if(millis()>packet->deadline){
        packet->status=1;packet->wsa=10060;packet->state=DONE;signal_output();unlock();return 1;
    }
    unlock();
    (void)drain_errors();
#ifdef UDP_TEST_RACE
    /* Test-only real ICMP arriving AFTER predrain and BEFORE sendto(B).
     * No fabricated errno, mocked socket, retry, or product delay. */
    if(inject_peer==packet->peer){
        struct sockaddr_storage trigger;int size=to_native(&inject_address,&trigger);
        inject_peer=0;inject=1;
        trigger_result=(int)sendto(native_socket,"r",1,0,(struct sockaddr*)&trigger,(SockLen)size);
#ifdef _WIN32
        {
            fd_set readable;struct timeval timeout;
            FD_ZERO(&readable);FD_SET(native_socket,&readable);timeout.tv_sec=0;timeout.tv_usec=500000;
            readiness=select(0,&readable,NULL,NULL,&timeout);
        }
#else
        {
            struct pollfd ready={native_socket,POLLERR,0};
            readiness=poll(&ready,1,500)>0?(int)ready.revents:0;
        }
#endif
    }
#endif
    length=to_native(&packet->address,&name);packet->attempts++;
    n=(int)sendto(native_socket,(const char*)packet->data,(int)packet->length,0,(struct sockaddr*)&name,(SockLen)length);
    e=n<0?socket_error():0;
#ifdef UDP_TEST_RACE
    if(inject){
        uint8_t proof[20];put32(proof,packet->peer);put32(proof+4,(uint32_t)trigger_result);put32(proof+8,(uint32_t)readiness);
        put32(proof+12,(uint32_t)n);put32(proof+16,(uint32_t)e);
        lock();output_locked(113,packet->id,proof,sizeof(proof));unlock();
    }
#endif
    if(n>=0){
        lock();packet->status=0;packet->state=DONE;accepted++;signal_output();unlock();return 1;
    }
    if(would_block(e))return 0;
#ifndef _WIN32
    if(e==EINTR)return 1;
    if(e==ECONNREFUSED||e==EHOSTUNREACH||e==ENETUNREACH){
        /* This packet was not accepted. ERRQUEUE's original tuple is independent
         * of this SEND. Keep the identical packet reservation and retry later. */
        (void)drain_errors();return 1;
    }
#endif
    lock();packet->status=1;packet->wsa=local_error(e);packet->native_error=(uint32_t)e;
    packet->state=DONE;signal_output();unlock();return 1;
}
static void wait_main(int blocked_tx){
#ifdef _WIN32
    HANDLE events[2];DWORD count=1;
    events[0]=input_event;
    if(native_socket!=BAD_SOCKET&&socket_event!=WSA_INVALID_EVENT){events[1]=socket_event;count=2;}
    if(WaitForMultipleObjects(count,events,FALSE,blocked_tx?100:INFINITE)==WAIT_OBJECT_0+1){
        WSANETWORKEVENTS value;(void)WSAEnumNetworkEvents(native_socket,socket_event,&value);
    }
    (void)blocked_tx;
#else
    struct pollfd descriptors[2];int count=1;
    descriptors[0]=(struct pollfd){wake_pipe[0],POLLIN,0};
    if(native_socket!=BAD_SOCKET)descriptors[count++]=(struct pollfd){native_socket,(short)(POLLIN|POLLERR|(blocked_tx?POLLOUT:0)),0};
    (void)poll(descriptors,(nfds_t)count,blocked_tx?100:-1);
    if(descriptors[0].revents&POLLIN){uint8_t bytes[128];while(read(wake_pipe[0],bytes,sizeof(bytes))>0){}}
#endif
}
static void close_native_locked(void){
    int i;
    if(native_closed)return;
    if(native_socket!=BAD_SOCKET){close_socket(native_socket);native_socket=BAD_SOCKET;}
    native_closed=1;
    for(i=0;i<RX_CAP;i++)if(rx[i].used){drop_packets++;drop_bytes+=rx[i].length;free(rx[i].data);rx[i].used=0;}
    rx_count=rx_bytes=0;signal_output();
}
int main(void){
    Thread reader,writer;int exit_code=0;
#ifdef _WIN32
    WSADATA startup;
    if(WSAStartup(MAKEWORD(2,2),&startup)!=0)return 2;
    _setmode(0,_O_BINARY);_setmode(1,_O_BINARY);
    InitializeCriticalSection(&mutex);InitializeConditionVariable(&output_ready);
    input_event=CreateEvent(NULL,FALSE,FALSE,NULL);if(!input_event)return 2;
    reader=CreateThread(NULL,0,input_thread,NULL,0,NULL);writer=CreateThread(NULL,0,output_thread,NULL,0,NULL);
    if(!reader||!writer)return 2;
#else
    signal(SIGPIPE,SIG_IGN);
    pthread_mutex_init(&mutex,NULL);pthread_cond_init(&output_ready,NULL);
    if(pipe(wake_pipe)!=0)return 2;
    if(fcntl(wake_pipe[0],F_SETFL,O_NONBLOCK)<0||fcntl(wake_pipe[1],F_SETFL,O_NONBLOCK)<0)return 2;
    if(pthread_create(&reader,NULL,input_thread,NULL)||pthread_create(&writer,NULL,output_thread,NULL))return 2;
#endif
    for(;;){
        int turn,progress=0,pending,done,was_fatal;
        lock();if(aborting)close_native_locked();unlock();
        if(native_socket!=BAD_SOCKET){(void)drain_errors();receive_datagrams();}
        for(turn=0;turn<32;turn++){if(!process_control())break;progress=1;}
        for(turn=0;turn<32;turn++){if(!send_one())break;progress=1;}
        lock();
        pending=minimum_tx_sequence()!=UINT64_MAX;
        if((closing||fatal||reader_finished)&&!pending&&!prior_control_pending()&&!native_closed){
            close_native_locked();
        }
        done=writer_finished;was_fatal=fatal;
        if(done)close_native_locked();
        unlock();
        if(done){exit_code=was_fatal?1:0;break;}
        if(!progress)wait_main(pending);
    }
    /* The parent keeps draining results through CLOSED, with its own bounded
     * shutdown deadline. A lost pipe is a binding failure, never a send replay. */
#ifdef _WIN32
    if(WaitForSingleObject(reader,1000)!=WAIT_OBJECT_0){
#ifndef UDP_TEST_SKIP_READER_CANCEL
        (void)CancelSynchronousIo(reader);
#endif
        if(WaitForSingleObject(reader,1000)!=WAIT_OBJECT_0){
            /* A cancellation can miss the gap between two reads. Do not destroy
             * synchronization still reachable by that live thread. Native work
             * and stdout completion already retired; process exit owns cleanup. */
            fprintf(stderr,"bound UDP helper: reader did not quiesce\n");
            ExitProcess((UINT)exit_code);
        }
    }
    if(WaitForSingleObject(writer,1000)!=WAIT_OBJECT_0){
        fprintf(stderr,"bound UDP helper: writer did not quiesce\n");
        ExitProcess((UINT)exit_code);
    }
    CloseHandle(reader);CloseHandle(writer);CloseHandle(input_event);
    if(socket_event!=WSA_INVALID_EVENT)WSACloseEvent(socket_event);
    DeleteCriticalSection(&mutex);WSACleanup();
#else
    pthread_cancel(reader);pthread_join(reader,NULL);pthread_join(writer,NULL);close(wake_pipe[0]);close(wake_pipe[1]);
    pthread_cond_destroy(&output_ready);pthread_mutex_destroy(&mutex);
#endif
    (void)writer_failed;return exit_code;
}
