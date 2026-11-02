/* Native-only ordinary unconnected UDP probe. Loopback sockets only, no RAW or privileges.
 * Fresh executable/output; the previous udp-icmp-tuple-native reference is immutable.
 */
#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mswsock.h>
#include <stdio.h>
#include <string.h>
#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET 0x9800000c
#endif
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif

typedef struct { int result,error,readable,exceptional; } Wait;
typedef struct { int result,error; } Operation;
typedef struct {
    int result,error,name_length; DWORD bytes,flags,control_length;
    unsigned char name[32],data[16],control[64];
} Receive;
static int address_size(int family){return family==AF_INET?(int)sizeof(struct sockaddr_in):(int)sizeof(struct sockaddr_in6);}
static unsigned port_of(const void*name){
    const struct sockaddr*sa=name;
    if(sa->sa_family==AF_INET)return ntohs(((const struct sockaddr_in*)name)->sin_port);
    if(sa->sa_family==AF_INET6)return ntohs(((const struct sockaddr_in6*)name)->sin6_port);
    return 0;
}
static int address_matches(const void*name,const SOCKADDR_STORAGE*expected){
    const struct sockaddr*sa=name;
    if(sa->sa_family!=expected->ss_family||port_of(name)!=port_of(expected))return 0;
    if(sa->sa_family==AF_INET)return ((const struct sockaddr_in*)name)->sin_addr.s_addr==((const struct sockaddr_in*)expected)->sin_addr.s_addr;
    return memcmp(&((const struct sockaddr_in6*)name)->sin6_addr,&((const struct sockaddr_in6*)expected)->sin6_addr,16)==0;
}
static SOCKET open_local(int family,SOCKADDR_STORAGE*address){
    SOCKET s=socket(family,SOCK_DGRAM,IPPROTO_UDP);int size=(int)sizeof(*address);u_long nonblock=1;
    memset(address,0,sizeof(*address));address->ss_family=(ADDRESS_FAMILY)family;
    if(family==AF_INET)((struct sockaddr_in*)address)->sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    else ((struct sockaddr_in6*)address)->sin6_addr.u.Byte[15]=1;
    if(s==INVALID_SOCKET)return s;
    if(bind(s,(struct sockaddr*)address,address_size(family))==SOCKET_ERROR||
       getsockname(s,(struct sockaddr*)address,&size)==SOCKET_ERROR||ioctlsocket(s,FIONBIO,&nonblock)==SOCKET_ERROR){
        closesocket(s);return INVALID_SOCKET;
    }
    return s;
}
static Wait wait_read(SOCKET s,int millis){
    fd_set read,exceptional;struct timeval timeout;Wait result;
    FD_ZERO(&read);FD_ZERO(&exceptional);FD_SET(s,&read);FD_SET(s,&exceptional);
    timeout.tv_sec=millis/1000;timeout.tv_usec=(millis%1000)*1000;
    WSASetLastError(0);result.result=select(0,&read,0,&exceptional,&timeout);result.error=WSAGetLastError();
    result.readable=FD_ISSET(s,&read)!=0;result.exceptional=FD_ISSET(s,&exceptional)!=0;return result;
}
static Operation send_byte(SOCKET s,const SOCKADDR_STORAGE*to,int family,char byte){
    Operation result;WSASetLastError(0x1234);
    result.result=sendto(s,&byte,1,0,(const struct sockaddr*)to,address_size(family));
    result.error=WSAGetLastError();return result;
}
static Receive receive_one(SOCKET s,LPFN_WSARECVMSG fn){
    Receive result;WSABUF buffer;WSAMSG message;
    memset(&result,0,sizeof(result));memset(result.name,0xa5,sizeof(result.name));
    memset(result.data,0xa5,sizeof(result.data));memset(result.control,0xa5,sizeof(result.control));
    result.name_length=(int)sizeof(result.name);result.bytes=0xdeadbeef;result.control_length=(DWORD)sizeof(result.control);
    WSASetLastError(0x5678);
    if(fn){
        memset(&message,0,sizeof(message));buffer.buf=(char*)result.data;buffer.len=sizeof(result.data);
        message.name=(struct sockaddr*)result.name;message.namelen=sizeof(result.name);
        message.lpBuffers=&buffer;message.dwBufferCount=1;message.Control.buf=(char*)result.control;message.Control.len=sizeof(result.control);
        result.result=fn(s,&message,&result.bytes,0,0);result.error=WSAGetLastError();
        result.name_length=message.namelen;result.flags=message.dwFlags;result.control_length=message.Control.len;
    }else{
        result.result=recvfrom(s,(char*)result.data,sizeof(result.data),0,(struct sockaddr*)result.name,&result.name_length);
        result.error=WSAGetLastError();
    }
    return result;
}
static void print_hex(const void*pointer,size_t length){
    const unsigned char*bytes=pointer;size_t i;putchar('"');for(i=0;i<length;i++)printf("%02x",bytes[i]);putchar('"');
}
static void print_wait(Wait value){printf("{\"result\":%d,\"lastError\":%d,\"readable\":%d,\"exceptional\":%d}",value.result,value.error,value.readable,value.exceptional);}
static void print_op(Operation value){printf("{\"result\":%d,\"lastError\":%d}",value.result,value.error);}
static void print_receive(Receive*value){
    printf("{\"result\":%d,\"lastError\":%d,\"nameLength\":%d,\"bytesOut\":%lu,\"flags\":%lu,\"controlLength\":%lu,\"nameHex\":",
        value->result,value->error,value->name_length,(unsigned long)value->bytes,(unsigned long)value->flags,(unsigned long)value->control_length);
    print_hex(value->name,sizeof(value->name));printf(",\"payloadHex\":");print_hex(value->data,sizeof(value->data));
    printf(",\"controlHex\":");print_hex(value->control,sizeof(value->control));putchar('}');
}
static int warmup(SOCKET client,SOCKET peer,const SOCKADDR_STORAGE*address,const SOCKADDR_STORAGE*self,int family,char byte){
    Operation sent=send_byte(client,address,family,byte);Wait ready=wait_read(peer,500);Receive got=receive_one(peer,0);
    return sent.result==1&&ready.result==1&&got.result==1&&got.data[0]==(unsigned char)byte&&address_matches(got.name,self);
}
static int probe(int family,int mode,int api){
    SOCKADDR_STORAGE a_address,b_address,self,after;SOCKET a,b,client;
    DWORD returned=0xabcdef01;BOOL reset=mode==1;GUID id=WSAID_WSARECVMSG;LPFN_WSARECVMSG fn=0;
    Operation trigger,b_send,retry={-999,0},reply_send;Wait pending,b_wait,retry_wait={-999,0,0,0},reply_wait;
    Receive before,drained,retried,reply;int valid,setup,after_size=(int)sizeof(after),after_result,retry_attempted;
    a=open_local(family,&a_address);b=open_local(family,&b_address);client=open_local(family,&self);
    setup=a!=INVALID_SOCKET&&b!=INVALID_SOCKET&&client!=INVALID_SOCKET;
    if(!setup){printf("{\"family\":%d,\"mode\":%d,\"api\":%d,\"setup\":false}",family==AF_INET?4:6,mode,api);return 1;}
    if(mode&&WSAIoctl(client,SIO_UDP_CONNRESET,&reset,sizeof(reset),0,0,&returned,0,0)==SOCKET_ERROR)setup=0;
    if(api&&(WSAIoctl(client,SIO_GET_EXTENSION_FUNCTION_POINTER,&id,sizeof(id),&fn,sizeof(fn),&returned,0,0)==SOCKET_ERROR||!fn))setup=0;
    setup=setup&&warmup(client,a,&a_address,&self,family,'a')&&warmup(client,b,&b_address,&self,family,'b');
    closesocket(a);
    trigger=send_byte(client,&a_address,family,'x');
    pending=wait_read(client,250); /* Observe readiness without consuming the error. */
    b_send=send_byte(client,&b_address,family,'Y'); /* Deliberately BEFORE receive/error drain. */
    b_wait=wait_read(b,150);before=receive_one(b,0);
    drained=receive_one(client,api?fn:0);
    memset(&retried,0,sizeof(retried));retried.result=-999;retry_attempted=b_send.result==SOCKET_ERROR;
    if(retry_attempted){retry=send_byte(client,&b_address,family,'Y');retry_wait=wait_read(b,500);retried=receive_one(b,0);}
    reply_send=send_byte(b,&self,family,'R');reply_wait=wait_read(client,500);reply=receive_one(client,0);
    memset(&after,0,sizeof(after));after_result=getsockname(client,(struct sockaddr*)&after,&after_size);
    valid=setup&&trigger.result==1&&pending.result>=0&&(mode==2||pending.result>0)&&
        ((b_send.result==1&&before.result==1&&before.data[0]=='Y'&&address_matches(before.name,&self))||
         (retry_attempted&&before.result==SOCKET_ERROR&&before.error==WSAEWOULDBLOCK&&retry.result==1&&retried.result==1&&
          retried.data[0]=='Y'&&address_matches(retried.name,&self)))&&
        (drained.error!=WSAECONNRESET||address_matches(drained.name,&a_address))&&
        reply_send.result==1&&reply_wait.result>0&&reply.result==1&&reply.data[0]=='R'&&address_matches(reply.name,&b_address)&&
        after_result==0&&port_of(&after)==port_of(&self);
    printf("{\"family\":%d,\"resetMode\":\"%s\",\"receiveApi\":\"%s\",\"setup\":%s,\"peerAPort\":%u,\"peerBPort\":%u,\"clientPort\":%u,",
        family==AF_INET?4:6,mode==0?"default":mode==1?"on":"off",api?"WSARecvMsg":"recvfrom",setup?"true":"false",port_of(&a_address),port_of(&b_address),port_of(&self));
    printf("\"closedASend\":");print_op(trigger);printf(",\"pendingWait\":");print_wait(pending);
    printf(",\"sendBBeforeDrain\":");print_op(b_send);printf(",\"bBeforeDrain\":{\"wait\":");print_wait(b_wait);printf(",\"receive\":");print_receive(&before);putchar('}');
    printf(",\"errorDrain\":");print_receive(&drained);printf(",\"drainNameMatchesA\":%s,\"retry\":{\"attempted\":%s,\"send\":",
        address_matches(drained.name,&a_address)?"true":"false",retry_attempted?"true":"false");print_op(retry);
    printf(",\"wait\":");print_wait(retry_wait);printf(",\"receive\":");print_receive(&retried);putchar('}');
    printf(",\"livePeerReply\":{\"send\":");print_op(reply_send);printf(",\"wait\":");print_wait(reply_wait);printf(",\"receive\":");print_receive(&reply);putchar('}');
    printf(",\"sourcePortAfter\":%u,\"sourcePortUnchanged\":%s,\"caseValid\":%s}",port_of(&after),after_result==0&&port_of(&after)==port_of(&self)?"true":"false",valid?"true":"false");
    closesocket(b);closesocket(client);return valid?0:1;
}
int main(void){
    WSADATA data;int family,mode,api,first=1,failed=0,startup=WSAStartup(MAKEWORD(2,2),&data);
    printf("{\"nativeOnly\":true,\"platform\":\"Windows x86\",\"nonce\":%u,\"startup\":%d,\"cases\":[",(unsigned)ORACLE_NONCE,startup);
    if(startup)return 10;
    for(family=0;family<2;family++)for(mode=0;mode<3;mode++)for(api=0;api<2;api++){
        if(!first)putchar(',');
        first=0;failed|=probe(family?AF_INET6:AF_INET,mode,api);
    }
    printf("],\"cleanup\":%d}\n",WSACleanup());return failed?1:0;
}
