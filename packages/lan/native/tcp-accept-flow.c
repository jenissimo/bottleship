/* Portable per-child data escrow; all calls occur on the actor thread. */
#include "tcp-accept-flow.h"
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#define FLOW_ERROR SOCKET_ERROR
#define FLOW_WOULD_BLOCK (WSAGetLastError()==WSAEWOULDBLOCK)
#define FLOW_SHUT_WR SD_SEND
#else
#include <errno.h>
#include <sys/socket.h>
#define FLOW_ERROR (-1)
#define FLOW_WOULD_BLOCK (errno==EAGAIN || errno==EWOULDBLOCK)
#define FLOW_SHUT_WR SHUT_WR
#endif

#ifndef TCP_FLOW_SEND
#define TCP_FLOW_SEND(s,b,n,flags) send(s,b,n,flags)
#endif

void tcp_flow_init(struct tcp_accept_flow *f) { memset(f,0,sizeof(*f)); }
int tcp_flow_enqueue(struct tcp_accept_flow *f,unsigned kind,uint32_t id,const void *data,unsigned n) {
    unsigned char *copy=NULL;
    if(!f||f->retired||f->fin_queued||f->count>=TCP_FLOW_RECORDS+1) return 0;
    if(kind==TCP_FLOW_FIN) {
        if(id||data||n) return 0;
    } else {
        if((kind!=TCP_FLOW_DATA&&kind!=TCP_FLOW_OOB)||!id||
           !data||!n||n>TCP_FLOW_SEGMENT||(kind==TCP_FLOW_OOB&&n!=1)||
           f->data_records>=TCP_FLOW_RECORDS||n>TCP_FLOW_WINDOW-f->payload) return 0;
        copy=(unsigned char*)malloc(n);if(!copy)return 0;memcpy(copy,data,n);
    }
    struct tcp_flow_record *r=&f->records[(f->head+f->count)%(TCP_FLOW_RECORDS+1)];
    r->kind=kind;r->id=id;r->length=n;r->offset=0;r->data=copy;
    f->count++;f->payload+=n;
    if(kind==TCP_FLOW_FIN) f->fin_queued=1;
    else f->data_records++;
    return 1;
}
static void pop(struct tcp_accept_flow *f) {
    struct tcp_flow_record *r=&f->records[f->head];
    f->payload-=r->length;if(r->kind!=TCP_FLOW_FIN)f->data_records--;
    free(r->data);memset(r,0,sizeof(*r));f->head=(f->head+1)%(TCP_FLOW_RECORDS+1);f->count--;
}
int tcp_flow_send(struct tcp_accept_flow *f,const struct tcp_accept_owner *owner,uint64_t child,uint64_t permit,uint32_t *completed_id) {
    tcp_accept_socket s=tcp_accept_data_socket(owner,child,permit);
    if(!f||!completed_id||f->retired||s==TCP_ACCEPT_INVALID)return TCP_FLOW_ERROR;
    *completed_id=0;
    if(!f->count)return TCP_FLOW_BLOCKED;
    struct tcp_flow_record *r=&f->records[f->head];
    if(r->kind==TCP_FLOW_FIN) {
        if(shutdown(s,FLOW_SHUT_WR)==FLOW_ERROR)return TCP_FLOW_ERROR;
        pop(f);f->fin_sent=1;return TCP_FLOW_DONE;
    }
    int flags=r->kind==TCP_FLOW_OOB?MSG_OOB:0;
#ifdef MSG_NOSIGNAL
    flags|=MSG_NOSIGNAL;
#endif
    int n=TCP_FLOW_SEND(s,(const char*)r->data+r->offset,(int)(r->length-r->offset),flags);
    if(n==FLOW_ERROR)return FLOW_WOULD_BLOCK?TCP_FLOW_BLOCKED:TCP_FLOW_ERROR;
    if(n<=0)return TCP_FLOW_ERROR;
    r->offset+=(unsigned)n;
    if(r->offset!=r->length)return TCP_FLOW_PROGRESS;
    *completed_id=r->id;pop(f);return TCP_FLOW_DONE;
}
int tcp_flow_credit(struct tcp_accept_flow *f,unsigned n) {
    if(!f||f->retired||!n||n>TCP_FLOW_WINDOW-f->credit)return 0;
    f->credit+=n;return 1;
}
int tcp_flow_debit(struct tcp_accept_flow *f,unsigned n) {
    if(!f||f->retired||!n||n>f->credit)return 0;
    f->credit-=n;return 1;
}
void tcp_flow_retire(struct tcp_accept_flow *f) {
    if(!f||f->retired)return;
    while(f->count)pop(f);
    f->retired=1;f->credit=0;
}
