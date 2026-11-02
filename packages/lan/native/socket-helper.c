/*
 * BottleShip optional native TCP backend. Original code, Apache-2.0.
 * Binary stdin/stdout protocol is documented in README.md. No guest code executes
 * here. Each helper owns one socket; the parent resolves/authorizes its target.
 */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
typedef CRITICAL_SECTION mutex_t;
#define LOCK(m) EnterCriticalSection(m)
#define UNLOCK(m) LeaveCriticalSection(m)
#define INIT(m) InitializeCriticalSection(m)
#define CLOSESOCKET closesocket
#define WOULD_BLOCK WSAEWOULDBLOCK
#define SOCKERR() WSAGetLastError()
typedef SOCKET socket_t;
#else
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <unistd.h>
#include <fcntl.h>
#include <pthread.h>
#include <errno.h>
#include <signal.h>
typedef pthread_mutex_t mutex_t;
#define LOCK(m) pthread_mutex_lock(m)
#define UNLOCK(m) pthread_mutex_unlock(m)
#define INIT(m) pthread_mutex_init(m, NULL)
#define CLOSESOCKET close
#define INVALID_SOCKET (-1)
#define SOCKET_ERROR (-1)
#define WOULD_BLOCK EWOULDBLOCK
#define SOCKERR() errno
typedef int socket_t;
#endif
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#define SEGMENT 16384
#define MAX_PACKET 65535
#define WINDOW 262144
#define QUEUE 64
enum { CMD_DATA=1, CMD_OOB=2, CMD_FIN=3, CMD_CREDIT=4, CMD_CLOSE=5, CMD_OPTION=6, CMD_IP_OPTIONS=7, CMD_GUEST_ADDRESSES=8, CMD_UDP_TUPLE=9, CMD_NATIVE_OPTION=10, CMD_TCP_CONTROL=11 };
enum { EV_CONNECTED=10, EV_DATA=11, EV_OOB=12, EV_EOF=13, EV_ERROR=14, EV_ACK=15, EV_CLOSED=16, EV_RAW_DATA=17, EV_UDP_TUPLE=18, EV_FINISHED=19, EV_NATIVE_OPTION=20, EV_TCP_CONTROL=21 };
typedef struct { uint32_t kind, id, length, offset, prepared; unsigned char data[MAX_PACKET]; } command_t;
static command_t queue[QUEUE];
static unsigned head, count, queued_bytes, receive_credit;
static int stopped, input_error;
static mutex_t mutex;

static uint32_t get32(const unsigned char *p) { return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24); }
static void put32(unsigned char *p, uint32_t v) { p[0]=(unsigned char)v;p[1]=(unsigned char)(v>>8);p[2]=(unsigned char)(v>>16);p[3]=(unsigned char)(v>>24); }
static void pause_ms(void) {
#ifdef _WIN32
    Sleep(2);
#else
    struct timeval delay={0,2000}; select(0,NULL,NULL,NULL,&delay);
#endif
}
static int emit(uint32_t kind, const void *data, uint32_t length) {
    unsigned char header[8]; put32(header,kind);put32(header+4,length);
    if (fwrite(header,1,8,stdout)!=8 || (length && fwrite(data,1,length,stdout)!=length)) return 0;
    return fflush(stdout)==0;
}
static int emit32(uint32_t kind, uint32_t value) { unsigned char data[4];put32(data,value);return emit(kind,data,4); }
static int native_error(int code) {
#ifdef _WIN32
    return code;
#else
    switch (code) {
        case EACCES: case EPERM: return 10013;
        case EINVAL: return 10022;
        case EWOULDBLOCK: return 10035;
        case EMSGSIZE: return 10040;
        case EOPNOTSUPP: return 10045;
        case EAFNOSUPPORT: return 10047;
        case EADDRINUSE: return 10048;
        case EADDRNOTAVAIL: return 10049;
        case ENETDOWN: return 10050;
        case ENETUNREACH: return 10051;
        case ECONNRESET: case EPIPE: return 10054;
        case ENOBUFS: case ENOMEM: return 10055;
        case ENOTCONN: return 10057;
        case ETIMEDOUT: return 10060;
        case ECONNREFUSED: return 10061;
        case EHOSTUNREACH: return 10065;
        default: return 10054;
    }
#endif
}
/* Both setting and reporting use the actual native socket. The report is an
 * OS getsockopt result, not an echo of the requested value. */
static int native_tcp_option(socket_t connection,uint32_t option,int enabled) {
    if ((option!=1 && option!=2) || (enabled!=0 && enabled!=1)) return 10022;
    int level=option==1?SOL_SOCKET:IPPROTO_TCP, name=option==1?SO_KEEPALIVE:TCP_NODELAY;
    if (setsockopt(connection,level,name,(const char*)&enabled,sizeof(enabled))==SOCKET_ERROR) return native_error(SOCKERR());
    int observed=0;
#ifdef _WIN32
    int size=sizeof(observed);
#else
    socklen_t size=sizeof(observed);
#endif
    if (getsockopt(connection,level,name,(char*)&observed,&size)==SOCKET_ERROR) return native_error(SOCKERR());
    unsigned char payload[8];put32(payload,option);put32(payload+4,observed!=0);
    return emit(EV_NATIVE_OPTION,payload,8)?0:10054;
}
static unsigned checksum_sum(const unsigned char *data, unsigned length, unsigned sum) {
    for (unsigned index=0;index<length;index+=2) sum+=((unsigned)data[index]<<8)|(index+1<length?data[index+1]:0);
    while (sum>>16) sum=(sum&65535)+(sum>>16);
    return sum;
}
/* RFC 1624 address adjustment preserves intentionally invalid raw checksums. */
static void adjust_transport(unsigned char *data,unsigned length,unsigned protocol,int family,
    const unsigned char *old_source,const unsigned char *old_destination,
    const unsigned char *source,const unsigned char *destination) {
    unsigned offset=protocol==6?16:protocol==17?6:family==AF_INET6&&protocol==58?2:MAX_PACKET;
    if(offset+2>length)return;
    unsigned checksum=((unsigned)data[offset]<<8)|data[offset+1];
    if(protocol==17&&family==AF_INET&&!checksum)return;
    unsigned sum=(~checksum)&65535,size=family==AF_INET?4:16;
    for(unsigned index=0;index<size;index+=2){
        unsigned old_a=((unsigned)old_source[index]<<8)|old_source[index+1],old_b=((unsigned)old_destination[index]<<8)|old_destination[index+1];
        unsigned new_a=((unsigned)source[index]<<8)|source[index+1],new_b=((unsigned)destination[index]<<8)|destination[index+1];
        sum+=(~old_a)&65535;sum+=new_a;sum+=(~old_b)&65535;sum+=new_b;
    }
    while(sum>>16)sum=(sum&65535)+(sum>>16);
    checksum=(~sum)&65535;if(protocol==17&&!checksum)checksum=65535;
    data[offset]=(unsigned char)(checksum>>8);data[offset+1]=(unsigned char)checksum;
}
static int rewrite_raw_header(int family,unsigned char *data,unsigned length,const unsigned char *source,const unsigned char *destination) {
    unsigned header=family==AF_INET?(data[0]&15)*4:40;
    if(family==AF_INET){
        if(length<20||data[0]>>4!=4||header<20||header>length)return 10022;
        adjust_transport(data+header,length-header,data[9],family,data+12,data+16,source,destination);
        memcpy(data+12,source,4);memcpy(data+16,destination,4);
        data[2]=(unsigned char)(length>>8);data[3]=(unsigned char)length;data[10]=data[11]=0;
        unsigned sum=(~checksum_sum(data,header,0))&65535;data[10]=(unsigned char)(sum>>8);data[11]=(unsigned char)sum;
    }else{
        if(length<40||data[0]>>4!=6)return 10022;
        adjust_transport(data+40,length-40,data[6],family,data+8,data+24,source,destination);
        memcpy(data+8,source,16);memcpy(data+24,destination,16);
        unsigned payload=length-40;data[4]=(unsigned char)(payload>>8);data[5]=(unsigned char)payload;
    }
    return 0;
}
static int peer_matches(const struct sockaddr_storage *expected,const struct sockaddr_storage *actual){
    if(expected->ss_family!=actual->ss_family)return 0;
    if(actual->ss_family==AF_INET)return memcmp(&((const struct sockaddr_in*)expected)->sin_addr,&((const struct sockaddr_in*)actual)->sin_addr,4)==0;
    return memcmp(&((const struct sockaddr_in6*)expected)->sin6_addr,&((const struct sockaddr_in6*)actual)->sin6_addr,16)==0 &&
        (!((const struct sockaddr_in6*)expected)->sin6_scope_id||((const struct sockaddr_in6*)expected)->sin6_scope_id==((const struct sockaddr_in6*)actual)->sin6_scope_id);
}

/* A kernel UDP reservation owns each translated port. Raw capture is still the
 * data path: this socket prevents port reuse and native ICMP port-unreachable. */
typedef struct { socket_t reservation;unsigned guest,peer,native;int active; } udp_tuple_t;
static int udp_tuple_open(udp_tuple_t *tuple,int family,const struct sockaddr_storage *local,unsigned guest,unsigned peer){
    if(guest>65535||peer>65535)return 10022;
    if(tuple->active)return tuple->guest==guest&&tuple->peer==peer?0:10022;
    socket_t descriptor=socket(family,SOCK_DGRAM,IPPROTO_UDP);
    if(descriptor==INVALID_SOCKET)return native_error(SOCKERR());
    struct sockaddr_storage address=*local;
    if(family==AF_INET)((struct sockaddr_in*)&address)->sin_port=0;
    else ((struct sockaddr_in6*)&address)->sin6_port=0;
#ifdef _WIN32
    int exclusive=1;
    if(setsockopt(descriptor,SOL_SOCKET,SO_EXCLUSIVEADDRUSE,(const char*)&exclusive,sizeof(exclusive))){int failure=native_error(SOCKERR());CLOSESOCKET(descriptor);return failure;}
    int size=family==AF_INET?sizeof(struct sockaddr_in):sizeof(struct sockaddr_in6);
#else
    socklen_t size=family==AF_INET?sizeof(struct sockaddr_in):sizeof(struct sockaddr_in6);
#endif
    if(bind(descriptor,(struct sockaddr*)&address,size)||getsockname(descriptor,(struct sockaddr*)&address,&size)){
        int failure=native_error(SOCKERR());CLOSESOCKET(descriptor);return failure;
    }
#ifdef _WIN32
    u_long nonblocking=1;if(ioctlsocket(descriptor,FIONBIO,&nonblocking)){int failure=native_error(SOCKERR());CLOSESOCKET(descriptor);return failure;}
#else
    if(fcntl(descriptor,F_SETFL,fcntl(descriptor,F_GETFL,0)|O_NONBLOCK)){int failure=native_error(SOCKERR());CLOSESOCKET(descriptor);return failure;}
#endif
    tuple->reservation=descriptor;tuple->guest=guest;tuple->peer=peer;
    tuple->native=ntohs(family==AF_INET?((struct sockaddr_in*)&address)->sin_port:((struct sockaddr_in6*)&address)->sin6_port);tuple->active=1;return 0;
}
static void udp_tuple_close(udp_tuple_t *tuple){if(tuple->active)CLOSESOCKET(tuple->reservation);tuple->active=0;}
/* Return -1 for a foreign incoming tuple, a Winsock error for unsupported packet
 * structure, or zero after RFC 1624 port translation. Never repair bad checksums. */
static int udp_tuple_translate(const udp_tuple_t *tuple,int family,int included,unsigned char *packet,unsigned length,int outbound){
    unsigned offset=0;
    if(!tuple->active)return 10022;
    if(included){
        if(family==AF_INET){
            if(length<20||packet[0]>>4!=4)return 10022;
            offset=(packet[0]&15)*4;if(offset<20||offset>length||packet[9]!=17)return 10022;
            if((((unsigned)packet[6]<<8)|packet[7])&0x3fff)return 10045;
        }else{
            if(length<40||packet[0]>>4!=6)return 10022;
            if(packet[6]!=17)return 10045;
            offset=40;
        }
    }
    if(length-offset<8)return 10022;
    unsigned char *udp=packet+offset;
    unsigned source=((unsigned)udp[0]<<8)|udp[1],destination=((unsigned)udp[2]<<8)|udp[3];
    if(outbound){if(source!=tuple->guest||destination!=tuple->peer)return 10022;}
    else if(source!=tuple->peer||destination!=tuple->native)return -1;
    unsigned index=outbound?0:2,old=outbound?source:destination,next=outbound?tuple->native:tuple->guest;
    unsigned checksum=((unsigned)udp[6]<<8)|udp[7];
    if(checksum||family==AF_INET6){
        unsigned sum=((~checksum)&65535)+((~old)&65535)+next;
        while(sum>>16)sum=(sum&65535)+(sum>>16);
        checksum=(~sum)&65535;if(!checksum)checksum=65535;udp[6]=(unsigned char)(checksum>>8);udp[7]=(unsigned char)checksum;
    }
    udp[index]=(unsigned char)(next>>8);udp[index+1]=(unsigned char)next;return 0;
}

static int read_exact(void *data, size_t length) { return fread(data,1,length,stdin)==length; }
#ifndef _WIN32
static int at_mark(socket_t connection);
#endif
#include "tcp-io.h"
#ifdef _WIN32
static DWORD WINAPI input_thread(LPVOID unused) {
#else
static void *input_thread(void *unused) {
#endif
    unsigned char header[8], payload[MAX_PACKET+4];
    (void)unused;
    if(tcp_mode){
        tcp_read_input();
#ifdef _WIN32
        return 0;
#else
        return NULL;
#endif
    }
    for (;;) {
        if (!read_exact(header,8)) break;
        uint32_t kind=get32(header), length=get32(header+4);
        if (length>sizeof(payload) || !read_exact(payload,length)) { LOCK(&mutex);input_error=10022;UNLOCK(&mutex);break; }
        if (kind==CMD_CREDIT && length==4) {
            uint32_t add=get32(payload);
            LOCK(&mutex);
            if (!add || add>WINDOW-receive_credit) input_error=10022;
            else receive_credit+=add;
            UNLOCK(&mutex);
            continue;
        }
        if (kind==CMD_CLOSE && !length) break;
        if (!((kind==CMD_DATA && length>=4) || (kind==CMD_OOB && length==5) || (kind==CMD_FIN && !length) || (kind==CMD_OPTION && length==4 && get32(payload)<=1) || (kind==CMD_NATIVE_OPTION && length==8 && (get32(payload)==1 || get32(payload)==2) && get32(payload+4)<=1) || (kind==CMD_GUEST_ADDRESSES && length==36 && (get32(payload)==4 || get32(payload)==6)) || (kind==CMD_UDP_TUPLE && length==8 && get32(payload)<=65535 && get32(payload+4)<=65535) || (kind==CMD_IP_OPTIONS && length==8 && (int32_t)get32(payload)>=-1 && (int32_t)get32(payload)<=255 && get32(payload+4)<=255))) {
            LOCK(&mutex);input_error=10022;UNLOCK(&mutex);break;
        }
        for (;;) {
            LOCK(&mutex);
            if (stopped) { UNLOCK(&mutex);goto done; }
            if (count<QUEUE && queued_bytes+length<=WINDOW) {
                command_t *command=&queue[(head+count)%QUEUE];
                command->kind=kind;command->id=length?get32(payload):0;
                command->length=length?length-4:0;command->offset=0;command->prepared=0;
                if (command->length) memcpy(command->data,payload+4,command->length);
                queued_bytes+=length;count++;
                UNLOCK(&mutex);break;
            }
            UNLOCK(&mutex);pause_ms();
        }
    }
done:
    LOCK(&mutex);stopped=1;UNLOCK(&mutex);
#ifdef _WIN32
    return 0;
#else
    return NULL;
#endif
}
#ifndef _WIN32
static int at_mark(socket_t socket) { return sockatmark(socket)==1; }
#endif
int main(int argc, char **argv) {
    if (argc!=4 && argc!=5 && argc!=7) return 2;
    int raw_family=strcmp(argv[1],"raw4")==0?AF_INET:strcmp(argv[1],"raw6")==0?AF_INET6:0;
    int udp_family=strcmp(argv[1],"udp4")==0?AF_INET:strcmp(argv[1],"udp6")==0?AF_INET6:0;
    int datagram_family=raw_family?raw_family:udp_family;
    tcp_mode=!datagram_family;
    if (!datagram_family && strcmp(argv[1],"tcp")!=0) return 2;
    if (datagram_family && argc==7) return 2;
    int inline_mode=!datagram_family && argc>=5 && strcmp(argv[4],"1")==0;
    int keep_alive=!datagram_family && argc==7 && strcmp(argv[5],"1")==0;
    int no_delay=!datagram_family && argc==7 && strcmp(argv[6],"1")==0;
    int header_included=raw_family && argc==5 && strcmp(argv[4],"1")==0;
    int raw_protocol=raw_family?atoi(argv[3]):0;
    if (raw_protocol<0 || raw_protocol>255) return 2;
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2,2),&wsa)!=0) return 3;
    _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#else
    signal(SIGPIPE,SIG_IGN);
#endif
    setvbuf(stdout,NULL,_IONBF,0);INIT(&mutex);
    struct addrinfo hints, *addresses=NULL, *address;
    memset(&hints,0,sizeof(hints));hints.ai_family=datagram_family?datagram_family:AF_UNSPEC;hints.ai_socktype=raw_family?SOCK_RAW:udp_family?SOCK_DGRAM:SOCK_STREAM;hints.ai_protocol=raw_family?raw_protocol:udp_family?IPPROTO_UDP:IPPROTO_TCP;
    if (getaddrinfo(argv[2],raw_family?NULL:argv[3],&hints,&addresses)!=0) { emit32(EV_ERROR,11001);return 1; }
    socket_t connection=INVALID_SOCKET;int last_error=10061;
    for (address=addresses;address;address=address->ai_next) {
        connection=socket(address->ai_family,address->ai_socktype,address->ai_protocol);
        if (connection==INVALID_SOCKET) { last_error=native_error(SOCKERR());continue; }
        if (raw_family && header_included) {
            int result;
            if (raw_family==AF_INET) result=setsockopt(connection,IPPROTO_IP,IP_HDRINCL,(const char*)&header_included,sizeof(header_included));
            else {
#ifdef IPV6_HDRINCL
                result=setsockopt(connection,IPPROTO_IPV6,IPV6_HDRINCL,(const char*)&header_included,sizeof(header_included));
#else
                result=SOCKET_ERROR;
#ifdef _WIN32
                WSASetLastError(WSAENOPROTOOPT);
#else
                errno=EOPNOTSUPP;
#endif
#endif
            }
            if (result==SOCKET_ERROR) { last_error=native_error(SOCKERR());CLOSESOCKET(connection);connection=INVALID_SOCKET;continue; }
        }
        if (inline_mode && setsockopt(connection,SOL_SOCKET,SO_OOBINLINE,(const char*)&inline_mode,sizeof(inline_mode))==SOCKET_ERROR) { last_error=native_error(SOCKERR());CLOSESOCKET(connection);connection=INVALID_SOCKET;continue; }
        if (!datagram_family) {
            int result=native_tcp_option(connection,1,keep_alive);
            if (!result) result=native_tcp_option(connection,2,no_delay);
            if (result) { last_error=result;CLOSESOCKET(connection);connection=INVALID_SOCKET;continue; }
        }
        if (connect(connection,address->ai_addr,(int)address->ai_addrlen)==0) break;
        last_error=native_error(SOCKERR());CLOSESOCKET(connection);connection=INVALID_SOCKET;
    }
    freeaddrinfo(addresses);
    if (connection==INVALID_SOCKET) { emit32(EV_ERROR,(uint32_t)last_error);return 1; }
    struct sockaddr_storage native_local,native_remote;
#ifdef _WIN32
    int local_size=sizeof(native_local),remote_size=sizeof(native_remote);
#else
    socklen_t local_size=sizeof(native_local),remote_size=sizeof(native_remote);
#endif
    if(getsockname(connection,(struct sockaddr*)&native_local,&local_size)||getpeername(connection,(struct sockaddr*)&native_remote,&remote_size)){
        emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));CLOSESOCKET(connection);return 1;
    }
    unsigned char native_source[16]={0},native_destination[16]={0},guest_source[16]={0},guest_destination[16]={0};
    int guest_addresses=0;
    if(raw_family){
        memcpy(native_source,raw_family==AF_INET?(void*)&((struct sockaddr_in*)&native_local)->sin_addr:(void*)&((struct sockaddr_in6*)&native_local)->sin6_addr,raw_family==AF_INET?4:16);
        memcpy(native_destination,raw_family==AF_INET?(void*)&((struct sockaddr_in*)&native_remote)->sin_addr:(void*)&((struct sockaddr_in6*)&native_remote)->sin6_addr,raw_family==AF_INET?4:16);
    }
    if(tcp_mode){int result=tcp_prepare_wait(connection);if(result){emit32(EV_ERROR,(uint32_t)result);CLOSESOCKET(connection);return 1;}}
#ifdef _WIN32
    u_long nonblocking=1;ioctlsocket(connection,FIONBIO,&nonblocking);
    HANDLE reader=CreateThread(NULL,0,input_thread,NULL,0,NULL);
    if (!reader) { CLOSESOCKET(connection);return 4; }
    CloseHandle(reader);
#else
    fcntl(connection,F_SETFL,fcntl(connection,F_GETFL,0)|O_NONBLOCK);
    pthread_t reader;
    if (pthread_create(&reader,NULL,input_thread,NULL)!=0) { CLOSESOCKET(connection);return 4; }
    pthread_detach(reader);
#endif
    if (!emit(EV_CONNECTED,NULL,0)) { CLOSESOCKET(connection);_Exit(1); }
    if(tcp_mode){int result=tcp_run(connection,inline_mode);CLOSESOCKET(connection);_Exit(result);}
    int eof=0, fin=0, urgent=0, failed=0;
    udp_tuple_t udp_tuple={INVALID_SOCKET,0,0,0,0};
    while (!failed) {
        LOCK(&mutex);
        int stop=stopped, failure=input_error;
        unsigned credit=receive_credit;
        command_t *command=count?&queue[head]:NULL;
        UNLOCK(&mutex);
        if (failure) { emit32(EV_ERROR,(uint32_t)failure);break; }
        if (stop) break;
        if (eof && fin && !command) { emit(EV_CLOSED,NULL,0);break; }
        /* Winsock rejects select() with three empty descriptor sets. */
        if ((eof || !credit) && !command) { pause_ms();continue; }
        fd_set reads,writes,exceptions;FD_ZERO(&reads);FD_ZERO(&writes);FD_ZERO(&exceptions);
        if (!eof && credit) { FD_SET(connection,&reads);if(!datagram_family)FD_SET(connection,&exceptions); }
        if (command) FD_SET(connection,&writes);
        if(udp_tuple.active)FD_SET(udp_tuple.reservation,&reads);
        socket_t maximum=udp_tuple.active&&udp_tuple.reservation>connection?udp_tuple.reservation:connection;
        struct timeval timeout={0,10000};
        int selected=select((int)maximum+1,&reads,&writes,&exceptions,&timeout);
        if (selected==SOCKET_ERROR) { emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));break; }
        if(udp_tuple.active&&FD_ISSET(udp_tuple.reservation,&reads)){unsigned char discarded[MAX_PACKET];recv(udp_tuple.reservation,(char*)discarded,MAX_PACKET,0);}
        /* Socket controls and shutdown do not require writable data capacity. */
        if (command && ((command->kind!=CMD_DATA && command->kind!=CMD_OOB) || FD_ISSET(connection,&writes))) {
            int complete=0;
            if (datagram_family && command->kind!=CMD_DATA && command->kind!=CMD_IP_OPTIONS && command->kind!=CMD_GUEST_ADDRESSES && command->kind!=CMD_UDP_TUPLE) { emit32(EV_ERROR,10045);break; }
            if(command->kind==CMD_UDP_TUPLE){
                if(!raw_family||raw_protocol!=17){emit32(EV_ERROR,10045);break;}
                int result=udp_tuple_open(&udp_tuple,raw_family,&native_local,command->id,get32(command->data));
                if(result){emit32(EV_ERROR,(uint32_t)result);break;}
                unsigned char tuple[12];put32(tuple,udp_tuple.guest);put32(tuple+4,udp_tuple.peer);put32(tuple+8,udp_tuple.native);
                if(!emit(EV_UDP_TUPLE,tuple,12))break;
                complete=1;
            }else if(command->kind==CMD_GUEST_ADDRESSES){
                if(!raw_family || (command->id==4?AF_INET:AF_INET6)!=raw_family){emit32(EV_ERROR,10022);break;}
                memcpy(guest_source,command->data,16);memcpy(guest_destination,command->data+16,16);guest_addresses=1;complete=1;
            } else if (command->kind==CMD_IP_OPTIONS) {
                int ttl=(int32_t)command->id,tos=(int)get32(command->data),level=datagram_family==AF_INET6?IPPROTO_IPV6:IPPROTO_IP;
                int ttl_option=datagram_family==AF_INET6?IPV6_UNICAST_HOPS:IP_TTL;
#ifdef IPV6_TCLASS
                int tos_option=datagram_family==AF_INET6?IPV6_TCLASS:IP_TOS;
#else
                if(datagram_family==AF_INET6) { emit32(EV_ERROR,10042);break; }
                int tos_option=IP_TOS;
#endif
                if (setsockopt(connection,level,ttl_option,(const char*)&ttl,sizeof(ttl))==SOCKET_ERROR || setsockopt(connection,level,tos_option,(const char*)&tos,sizeof(tos))==SOCKET_ERROR) { emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));break; }
                complete=1;
            } else if (command->kind==CMD_NATIVE_OPTION) {
                int result=native_tcp_option(connection,command->id,(int)get32(command->data));
                if (result) { emit32(EV_ERROR,(uint32_t)result);break; }
                complete=1;
            } else if (command->kind==CMD_OPTION) {
                inline_mode=(int)command->id;
                if (setsockopt(connection,SOL_SOCKET,SO_OOBINLINE,(const char*)&inline_mode,sizeof(inline_mode))==SOCKET_ERROR) { emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));break; }
                urgent=0;complete=1;
            } else if (command->kind==CMD_FIN) {
#ifdef _WIN32
                int result=shutdown(connection,SD_SEND);
#else
                int result=shutdown(connection,SHUT_WR);
#endif
                if (result==SOCKET_ERROR) { emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));break; }
                if (!emit(EV_FINISHED,NULL,0)) break;
                fin=1;complete=1;
            } else {
                if(raw_family&&udp_tuple.active&&!command->prepared){
                    int result=udp_tuple_translate(&udp_tuple,raw_family,header_included,command->data,command->length,1);
                    if(result){emit32(EV_ERROR,(uint32_t)result);break;}
                }
                if (raw_family && header_included && !command->prepared) {
                    int result=rewrite_raw_header(raw_family,command->data,command->length,native_source,native_destination);
                    if(result) { emit32(EV_ERROR,(uint32_t)result);break; }
                }
                if(raw_family && !header_included && guest_addresses && !command->prepared)
                    adjust_transport(command->data,command->length,(unsigned)raw_protocol,raw_family,guest_source,guest_destination,native_source,native_destination);
                command->prepared=1;
                int sent=send(connection,(const char*)command->data+command->offset,(int)(command->length-command->offset),command->kind==CMD_OOB?MSG_OOB:0);
                if (sent>0 || (datagram_family && sent==0 && !command->length)) { command->offset+=(unsigned)sent;complete=command->offset==command->length; }
                else if (sent==SOCKET_ERROR && SOCKERR()!=WOULD_BLOCK) { emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));break; }
            }
            if (complete) {
                if (command->kind!=CMD_FIN && command->kind!=CMD_OPTION && command->kind!=CMD_NATIVE_OPTION && command->kind!=CMD_IP_OPTIONS && command->kind!=CMD_GUEST_ADDRESSES && command->kind!=CMD_UDP_TUPLE && !emit32(EV_ACK,command->id)) break;
                LOCK(&mutex);queued_bytes-=command->length+(command->kind==CMD_FIN?0:4);head=(head+1)%QUEUE;count--;UNLOCK(&mutex);
            }
        }
        if (!inline_mode && FD_ISSET(connection,&exceptions)) urgent=1;
        /* Windows SIOCATMARK reports pending OOB, not the BSD stream mark.
         * MSG_PEEK stops at the first urgent boundary; consume that prefix before
         * fetching the separately queued urgent record. Normal recv may cross it. */
#ifdef _WIN32
        if (credit && urgent) {
            unsigned char prefix[SEGMENT];
            int peeked=recv(connection,(char*)prefix,(int)(credit<SEGMENT?credit:SEGMENT),MSG_PEEK);
            if (peeked>0) {
                int n=recv(connection,(char*)prefix,peeked,0);
                if (n>0) { LOCK(&mutex);receive_credit-=(unsigned)n;UNLOCK(&mutex);credit-=(unsigned)n;if (!emit(EV_DATA,prefix,(uint32_t)n)) break; }
            }
        }
#endif
        if (credit && urgent
#ifndef _WIN32
            && at_mark(connection)
#endif
        ) {
            unsigned char byte;
            int received=recv(connection,(char*)&byte,1,MSG_OOB);
            if (received==1) {
                LOCK(&mutex);receive_credit--;UNLOCK(&mutex);credit--;urgent=0;
                if (!emit(EV_OOB,&byte,1)) break;
            } else if (received==SOCKET_ERROR && SOCKERR()!=WOULD_BLOCK) { emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));break; }
        }
        if (credit && !eof && FD_ISSET(connection,&reads)) {
            unsigned char data[MAX_PACKET];
            struct sockaddr_storage packet_source;
#ifdef _WIN32
            int packet_source_size=sizeof(packet_source);
#else
            socklen_t packet_source_size=sizeof(packet_source);
#endif
            int limit=datagram_family?MAX_PACKET:(int)(credit<SEGMENT?credit:SEGMENT);
#ifdef _WIN32
            /* Read readiness is a snapshot: OOB can arrive before recv. Bound a
             * normal read by MSG_PEEK's prefix so it cannot cross a newly queued
             * mark. At the current mark Windows can still skip to the suffix;
             * that native API ambiguity is documented, not treated as parity. */
            int received=!datagram_family && !inline_mode?recv(connection,(char*)data,limit,MSG_PEEK):limit;
            if(received>0)received=raw_family?recvfrom(connection,(char*)data,received,0,(struct sockaddr*)&packet_source,&packet_source_size):recv(connection,(char*)data,received,0);
#else
            int received=raw_family?recvfrom(connection,(char*)data,limit,0,(struct sockaddr*)&packet_source,&packet_source_size):recv(connection,(char*)data,limit,0);
#endif
            if (received>0) {
                if(raw_family && !peer_matches(&native_remote,&packet_source))continue;
                if(raw_family&&udp_tuple.active&&udp_tuple_translate(&udp_tuple,raw_family,raw_family==AF_INET,data,(unsigned)received,0))continue;
                if(raw_family && guest_addresses){
                    if(raw_family==AF_INET){if(rewrite_raw_header(raw_family,data,(unsigned)received,guest_destination,guest_source))continue;}
                    else adjust_transport(data,(unsigned)received,(unsigned)raw_protocol,raw_family,native_destination,native_source,guest_destination,guest_source);
                }
                if (datagram_family && (unsigned)received>credit) continue; /* Datagram drop under congestion. */
                LOCK(&mutex);receive_credit-=(unsigned)received;UNLOCK(&mutex);
                if (!emit(datagram_family?EV_RAW_DATA:EV_DATA,data,(uint32_t)received)) break;
            } else if (!received && datagram_family) {
                if (!emit(EV_RAW_DATA,NULL,0)) break;
            } else if (!received) {
                eof=1;if (!emit(EV_EOF,NULL,0)) break;
            } else if (SOCKERR()!=WOULD_BLOCK) { emit32(EV_ERROR,(uint32_t)native_error(SOCKERR()));break; }
        }
    }
    LOCK(&mutex);stopped=1;UNLOCK(&mutex);udp_tuple_close(&udp_tuple);CLOSESOCKET(connection);
    /* A reader may still hold stdin\'s stdio lock. All output records were
     * explicitly flushed; avoid exit() trying to close that locked stream. */
    _Exit(failed?1:0);
}
