/* Bounded control/egress core; no threads, pipes or production integration. */
#include "tcp-accept-actor.h"
#include <string.h>
#ifdef _WIN32
#include <ws2tcpip.h>
#define ACTOR_ERROR() WSAGetLastError()
#define ACTOR_FALLBACK_ERROR WSAECONNRESET
#define ACTOR_CLOSED_ERROR WSAENOTSOCK
#define ACTOR_UNSUPPORTED_ERROR WSAEOPNOTSUPP
#define ACTOR_AGAIN(e) ((e)==WSAEWOULDBLOCK||(e)==WSAEINTR)
#else
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <errno.h>
#define ACTOR_ERROR() errno
#define ACTOR_FALLBACK_ERROR EIO
#define ACTOR_CLOSED_ERROR EBADF
#define ACTOR_UNSUPPORTED_ERROR EOPNOTSUPP
#define ACTOR_AGAIN(e) ((e)==EAGAIN||(e)==EWOULDBLOCK||(e)==EINTR)
#endif
#ifndef TCP_ACTOR_SETSOCKOPT
#define TCP_ACTOR_SETSOCKOPT(s,l,n,v,z) setsockopt(s,l,n,v,z)
#endif
#ifndef TCP_ACTOR_GETSOCKOPT
#define TCP_ACTOR_GETSOCKOPT(s,l,n,v,z) getsockopt(s,l,n,v,z)
#endif
static uint32_t get32(const unsigned char *p) {
    return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);
}
static uint64_t get64(const unsigned char *p) {return (uint64_t)get32(p)|((uint64_t)get32(p+4)<<32);}
static void put32(unsigned char *p,uint32_t n) {p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
static void put64(unsigned char *p,uint64_t n) {put32(p,(uint32_t)n);put32(p+4,(uint32_t)(n>>32));}
static int room(const struct tcp_accept_actor *a) {return a->out_count<TCP_ACTOR_NORMAL_OUTPUTS;}
static int control_room(const struct tcp_accept_actor *a) {return a->out_count<TCP_ACTOR_OUTPUTS;}
static void emit(struct tcp_accept_actor *a,unsigned op,uint32_t id,const unsigned char *body,unsigned length) {
    struct tcp_actor_event_record *r=&a->output[(a->out_head+a->out_count)%TCP_ACTOR_OUTPUTS];
    memset(r,0,sizeof(*r));r->length=TCP_ACTOR_HEADER+length;
    put32(r->bytes,r->length);r->bytes[4]=1;r->bytes[5]=(unsigned char)op;
    put32(r->bytes+8,id);put32(r->bytes+12,a->epoch);
    if(length)memcpy(r->bytes+TCP_ACTOR_HEADER,body,length);
    a->out_count++;
}
static int slot(const struct tcp_accept_actor *a,uint64_t child,uint64_t permit) {
    for(unsigned i=0;i<a->owner.limit;i++)
        if(a->owner.slots[i].child==child&&a->owner.slots[i].permit==permit&&
           tcp_accept_data_socket(&a->owner,child,permit)!=TCP_ACCEPT_INVALID)return (int)i;
    return -1;
}
int tcp_actor_init(struct tcp_accept_actor *a,uint32_t epoch,const char *host,uint16_t port,
                   const uint32_t *acl,unsigned count,unsigned limit) {
    uint16_t bound;unsigned char body[4];
    if(!a||!epoch)return 0;
    memset(a,0,sizeof(*a));a->epoch=epoch;
    if(!tcp_accept_init(&a->owner,host,port,acl,count,limit,&bound))return 0;
    put32(body,bound);emit(a,TCP_ACTOR_READY,0,body,4);return 1;
}
int tcp_actor_poll_listener(struct tcp_accept_actor *a) {
    if(!a||a->fatal)return -1;
    if(a->stopped||a->need||!room(a)||a->owner.next_child==UINT64_MAX)return 0;
    unsigned free_slot=0;
    for(unsigned i=0;i<a->owner.limit;i++)
        if(a->owner.slots[i].socket==TCP_ACCEPT_INVALID){free_slot=1;break;}
    if(!free_slot)return 0;
    int ready=tcp_accept_readable(&a->owner);
    if(ready<0){a->fatal=1;return -1;}
    if(!ready)return 0;
    a->need=1;emit(a,TCP_ACTOR_NEED,0,NULL,0);return 1;
}
/* ID remains owned while queued and until its ACK is physically popped. */
static int write_id_owned(const struct tcp_accept_actor *a,int index,uint64_t child,uint64_t permit,uint32_t id) {
    const struct tcp_accept_flow *f=&a->flows[index];
    for(unsigned i=0;i<f->count;i++) {
        const struct tcp_flow_record *r=&f->records[(f->head+i)%(TCP_FLOW_RECORDS+1)];
        if(r->kind!=TCP_FLOW_FIN&&r->id==id)return 1;
    }
    for(unsigned i=0;i<a->out_count;i++) {
        const struct tcp_actor_event_record *r=&a->output[(a->out_head+i)%TCP_ACTOR_OUTPUTS];
        if(r->bytes[5]==TCP_ACTOR_ACK&&get64(r->bytes+16)==child&&
           get64(r->bytes+24)==permit&&get32(r->bytes+32)==id)return 1;
    }
    return 0;
}
int tcp_actor_command(struct tcp_accept_actor *a,const unsigned char *frame,unsigned length) {
    unsigned op,bodylen;uint32_t id;const unsigned char *b;uint64_t child,permit;
    int index,result;unsigned char reply[32];
    if(!a||a->fatal)return -1;
    if(!frame||length<TCP_ACTOR_HEADER||length>TCP_ACTOR_FRAME_MAX||
       get32(frame)!=length||frame[4]!=1||frame[6]||frame[7]||get32(frame+12)!=a->epoch)goto invalid;
    op=frame[5];id=get32(frame+8);b=frame+TCP_ACTOR_HEADER;bodylen=length-TCP_ACTOR_HEADER;
    if(!id)goto invalid;
    if(op==TCP_ACTOR_GRANT) {
        struct tcp_accept_outcome out;
        if(bodylen!=8||!get64(b)||(!a->need&&!a->late_grant))goto invalid;
        if(!room(a))return 0;
        permit=get64(b);
        if(a->stopped) {
            if(!a->late_grant||permit<=a->owner.last_permit)goto invalid;
            memset(&out,0,sizeof(out));out.permit=permit;a->owner.last_permit=permit;
            a->late_grant=0;result=TCP_ACCEPT_UNUSED;
        } else {
            if(!a->need)goto invalid;
            result=tcp_accept_grant(&a->owner,permit,&out);a->need=0;
        }
        if(result==TCP_ACCEPT_FAILED){a->native_error=out.native_error;goto invalid;}
        if(result==TCP_ACCEPT_INVALID_INPUT||result==TCP_ACCEPT_RETAINED)goto invalid;
        memset(reply,0,sizeof(reply));put32(reply,(uint32_t)result);
        put64(reply+4,out.permit);put64(reply+12,out.child);
        memcpy(reply+20,&out.peer_ipv4,4);put32(reply+24,out.peer_port);
        if(result==TCP_ACCEPT_ADMITTED) {
            index=slot(a,out.child,out.permit);if(index<0)goto invalid;
            tcp_flow_init(&a->flows[index]);
        }
        emit(a,TCP_ACTOR_GRANT_RESULT,id,reply,28);return 1;
    }
    if(op==TCP_ACTOR_STOP) {
        if(bodylen||a->stopped)goto invalid;
        if(!control_room(a))return 0;
        if(tcp_accept_stop(&a->owner)!=1)goto invalid;
        a->stopped=1;a->late_grant=a->need;a->need=0;emit(a,TCP_ACTOR_STOPPED,id,NULL,0);return 1;
    }
    if(bodylen<16)goto invalid;
    child=get64(b);permit=get64(b+8);index=slot(a,child,permit);
    if(index<0)goto invalid;
    if(op==TCP_ACTOR_CLOSE_CHILD) {
        if(bodylen!=16)goto invalid;
        if(!control_room(a))return 0;
        if(tcp_accept_close(&a->owner,child,permit)!=1)goto invalid;
        tcp_flow_retire(&a->flows[index]);put64(reply,child);put64(reply+8,permit);
        emit(a,TCP_ACTOR_CHILD_CLOSED,id,reply,16);return 1;
    }
    if(op==TCP_ACTOR_OPTION) {
        if(bodylen!=24)goto invalid;
        unsigned option=get32(b+16),value=get32(b+20);int observed=0,error=0;
        if(option>2||value>1)goto invalid;
        for(unsigned i=0;i<a->out_count;i++) {
            const struct tcp_actor_event_record *r=&a->output[(a->out_head+i)%TCP_ACTOR_OUTPUTS];
            if(r->bytes[5]==TCP_ACTOR_OPTION_DONE&&get32(r->bytes+8)==id&&
               get64(r->bytes+16)==child&&get64(r->bytes+24)==permit)goto invalid;
        }
        if(!room(a))return 0;
        tcp_accept_socket s=tcp_accept_data_socket(&a->owner,child,permit);
        int level=option==2?IPPROTO_TCP:SOL_SOCKET;
        int name=option==0?SO_OOBINLINE:option==1?SO_KEEPALIVE:TCP_NODELAY;
        int enabled=(int)value;
        if(TCP_ACTOR_SETSOCKOPT(s,level,name,(const char*)&enabled,sizeof(enabled))!=0)error=ACTOR_ERROR();
        else {
            /* Successful OOBINLINE set changes the native receive mode even
             * if subsequent getsockopt fails. Commit the known requested bit
             * first; a successful observation can then refine it. */
            if(option==0)a->flows[index].inline_mode=enabled!=0;
#ifdef _WIN32
            int size=sizeof(observed);
#else
            socklen_t size=sizeof(observed);
#endif
            if(TCP_ACTOR_GETSOCKOPT(s,level,name,(char*)&observed,&size)!=0)error=ACTOR_ERROR();
            else if(option==0)a->flows[index].inline_mode=observed!=0;
        }
        put64(reply,child);put64(reply+8,permit);put32(reply+16,option);
        put32(reply+20,observed!=0);put32(reply+24,(uint32_t)error);
        emit(a,TCP_ACTOR_OPTION_DONE,id,reply,28);return 1;
    }
    if(op==TCP_ACTOR_CREDIT) {
        if(bodylen!=20||!tcp_flow_credit(&a->flows[index],get32(b+16)))goto invalid;
        return 1;
    }
    if(op==TCP_ACTOR_FIN) {
        if(bodylen!=16||!tcp_flow_enqueue(&a->flows[index],TCP_FLOW_FIN,0,NULL,0))goto invalid;
        return 1;
    }
    if(op==TCP_ACTOR_WRITE||op==TCP_ACTOR_URGENT) {
        struct tcp_accept_flow *f=&a->flows[index];unsigned size=bodylen-20;uint32_t write_id;
        if(bodylen<21||size>TCP_FLOW_SEGMENT||(op==TCP_ACTOR_URGENT&&size!=1)||f->retired||f->fin_queued)goto invalid;
        write_id=get32(b+16);
        if(!write_id||write_id_owned(a,index,child,permit,write_id))goto invalid;
        if(f->count>=TCP_FLOW_RECORDS+1||f->data_records>=TCP_FLOW_RECORDS||
           size>TCP_FLOW_WINDOW-f->payload)return 0;
        if(!tcp_flow_enqueue(f,op==TCP_ACTOR_WRITE?TCP_FLOW_DATA:TCP_FLOW_OOB,write_id,b+20,size))goto invalid;
        return 1;
    }
invalid:
    a->fatal=1;return -1;
}
int tcp_actor_option_closed(struct tcp_accept_actor *a,uint32_t id,uint64_t child,uint64_t permit,unsigned option) {
    unsigned char b[28];
    if(!a||a->fatal||!id||!child||!permit||option>2)return -1;
    if(!room(a))return 0;
    put64(b,child);put64(b+8,permit);put32(b+16,option);put32(b+20,0);put32(b+24,ACTOR_CLOSED_ERROR);
    emit(a,TCP_ACTOR_OPTION_DONE,id,b,28);return 1;
}
int tcp_actor_lifecycle_reply(struct tcp_accept_actor *a,unsigned op,uint32_t id) {
    if(!a||a->fatal||!id||(op!=TCP_ACTOR_QUIESCED&&op!=TCP_ACTOR_EXITING))return -1;
    if(op==TCP_ACTOR_QUIESCED?!room(a):!control_room(a))return 0;
    emit(a,op,id,NULL,0);return 1;
}
int tcp_actor_control_reply(struct tcp_accept_actor *a,unsigned op,uint32_t id,uint64_t child,uint64_t permit) {
    unsigned char b[16];
    if(!a||a->fatal||!id||!child||!permit||
       (op!=TCP_ACTOR_CLOSE_RETIRED&&op!=TCP_ACTOR_FENCE_DONE))return -1;
    if(!control_room(a))return 0;
    put64(b,child);put64(b+8,permit);emit(a,op,id,b,16);return 1;
}
int tcp_actor_barrier_done(struct tcp_accept_actor *a,uint32_t id,uint64_t child,uint64_t permit) {
    unsigned char b[16];
    if(!a||a->fatal||!id||!child||!permit)return -1;
    if(!room(a))return 0;
    put64(b,child);put64(b+8,permit);emit(a,TCP_ACTOR_BARRIER_DONE,id,b,16);return 1;
}
int tcp_actor_flush_child(struct tcp_accept_actor *a,uint64_t child,uint64_t permit) {
    unsigned char b[20];uint32_t id;int index,result;
    if(!a||a->fatal)return -1;
    index=slot(a,child,permit);if(index<0){a->fatal=1;return -1;}
    if(!room(a))return 0;
    result=tcp_flow_send(&a->flows[index],&a->owner,child,permit,&id);
    if(result==TCP_FLOW_ERROR){a->native_error=ACTOR_ERROR();if(!a->native_error)a->native_error=ACTOR_FALLBACK_ERROR;return -2;}
    if(result==TCP_FLOW_DONE) {
        put64(b,child);put64(b+8,permit);put32(b+16,id);
        emit(a,id?TCP_ACTOR_ACK:TCP_ACTOR_FINISHED,0,b,20);return 1;
    }
    return result==TCP_FLOW_PROGRESS?1:0;
}
int tcp_actor_receive_child(struct tcp_accept_actor *a,uint64_t child,uint64_t permit) {
    unsigned char b[16+TCP_FLOW_SEGMENT];int index,n,error;tcp_accept_socket s;
    if(!a||a->fatal)return -1;
    index=slot(a,child,permit);if(index<0){a->fatal=1;return -1;}
    struct tcp_accept_flow *f=&a->flows[index];
    if(f->read_eof||!f->credit||!room(a))return 0;
    s=tcp_accept_data_socket(&a->owner,child,permit);
    unsigned limit=f->credit<TCP_FLOW_SEGMENT?f->credit:TCP_FLOW_SEGMENT;
    if(!f->inline_mode) {
        fd_set exceptions;struct timeval zero={0,0};
#ifndef _WIN32
        if(s>=FD_SETSIZE){a->native_error=EINVAL;return -2;}
#endif
        FD_ZERO(&exceptions);FD_SET(s,&exceptions);
#ifdef _WIN32
        n=select(0,NULL,NULL,&exceptions,&zero);
#else
        n=select(s+1,NULL,NULL,&exceptions,&zero);
#endif
        if(n<0){error=ACTOR_ERROR();if(ACTOR_AGAIN(error))return 0;a->native_error=error;return -2;}
        /* Windows observations do not establish the urgent mark offset.
         * Do not consume speculative bytes once exceptional data is known. */
        if(n>0){a->native_error=ACTOR_UNSUPPORTED_ERROR;return -2;}
#ifdef _WIN32
        n=recv(s,(char*)b+16,(int)limit,MSG_PEEK);
        if(n>0)n=recv(s,(char*)b+16,n,0);
#else
        n=recv(s,(char*)b+16,(int)limit,0);
#endif
    } else n=recv(s,(char*)b+16,(int)limit,0);
    if(n<0){error=ACTOR_ERROR();if(ACTOR_AGAIN(error))return 0;a->native_error=error;return -2;}
    put64(b,child);put64(b+8,permit);
    if(n==0){f->read_eof=1;emit(a,TCP_ACTOR_EOF,0,b,16);return 1;}
    if(!tcp_flow_debit(f,(unsigned)n)){a->fatal=1;return -1;}
    emit(a,TCP_ACTOR_DATA,0,b,16+(unsigned)n);return 1;
}
int tcp_actor_fail_child(struct tcp_accept_actor *a,uint64_t child,uint64_t permit,int error) {
    unsigned char b[20];int index;
    if(!a||a->fatal)return -1;
    index=slot(a,child,permit);if(index<0){a->fatal=1;return -1;}
    if(!room(a))return 0;
    if(tcp_accept_close(&a->owner,child,permit)!=1){a->fatal=1;return -1;}
    tcp_flow_retire(&a->flows[index]);put64(b,child);put64(b+8,permit);put32(b+16,(uint32_t)error);
    emit(a,TCP_ACTOR_CHILD_ERROR,0,b,20);return 1;
}
const struct tcp_actor_event_record *tcp_actor_peek(const struct tcp_accept_actor *a) {
    return a&&a->out_count?&a->output[a->out_head]:NULL;
}
void tcp_actor_pop(struct tcp_accept_actor *a) {
    if(!a||!a->out_count)return;
    memset(&a->output[a->out_head],0,sizeof(a->output[a->out_head]));
    a->out_head=(a->out_head+1)%TCP_ACTOR_OUTPUTS;a->out_count--;
}
int tcp_actor_abort(struct tcp_accept_actor *a) {
    int clean=1;if(!a)return 0;
    a->fatal=1;a->need=0;
    for(unsigned i=0;i<a->owner.limit;i++) {
        struct tcp_accept_slot *s=&a->owner.slots[i];
        tcp_flow_retire(&a->flows[i]);
        if(s->socket!=TCP_ACCEPT_INVALID&&tcp_accept_close(&a->owner,s->child,s->permit)!=1)clean=0;
    }
    if(a->owner.listener!=TCP_ACCEPT_INVALID&&tcp_accept_stop(&a->owner)!=1)clean=0;
    return clean;
}
