/* Native-only UDP ICMP tuple oracle. Port numbers and output bytes are intentionally
 * retained verbatim; do not treat this as a normalized same-PE guest comparison.
 */
#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mswsock.h>
#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET 0x9800000c
#endif
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[2048];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void fill(void*ptr,DWORD size,BYTE value){BYTE*p=ptr;while(size--)*p++=value;}
static void outcome(int value){record(value);record(value==SOCKET_ERROR?WSAGetLastError():0);}
static int size_for(int family){return family==AF_INET?sizeof(struct sockaddr_in):sizeof(struct sockaddr_in6);}
static DWORD port_of(const SOCKADDR_STORAGE*address){return ntohs(address->ss_family==AF_INET?((const struct sockaddr_in*)address)->sin_port:((const struct sockaddr_in6*)address)->sin6_port);}
static int local(SOCKET socket,int family,SOCKADDR_STORAGE*address){
    int length=sizeof(*address);fill(address,sizeof(*address),0);address->ss_family=family;
    if(family==AF_INET)((struct sockaddr_in*)address)->sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    else ((struct sockaddr_in6*)address)->sin6_addr.u.Byte[15]=1;
    if(bind(socket,(struct sockaddr*)address,size_for(family))==SOCKET_ERROR)return -1;
    return getsockname(socket,(struct sockaddr*)address,&length);
}
static int wait_socket(SOCKET socket,int millis,int record_result){
    fd_set read,except;struct timeval timeout;int result;
    FD_ZERO(&read);FD_ZERO(&except);FD_SET(socket,&read);FD_SET(socket,&except);timeout.tv_sec=millis/1000;timeout.tv_usec=(millis%1000)*1000;
    result=select(0,&read,0,&except,&timeout);
    if(record_result){outcome(result);record(FD_ISSET(socket,&read)!=0);record(FD_ISSET(socket,&except)!=0);}
    return result;
}
static void words(const void*ptr,DWORD length){const DWORD*p=ptr;DWORD i;for(i=0;i<length/4;i++)record(p[i]);}
static void probe(int family,int mode,int api){
    SOCKET a=socket(family,SOCK_DGRAM,IPPROTO_UDP),b=socket(family,SOCK_DGRAM,IPPROTO_UDP),client=socket(family,SOCK_DGRAM,IPPROTO_UDP);
    SOCKADDR_STORAGE first,second,self;BYTE name[32],payload[16],control[64];int name_length=sizeof(name),result;
    DWORD nonblocking=1,returned=0xabcdef01,bytes=0xdeadbeef;BOOL reset=mode==1;
    WSAMSG message;WSABUF buffer;GUID extension=WSAID_WSARECVMSG;LPFN_WSARECVMSG receive_message=0;
    record(0x55445000|(family==AF_INET6?0x100:0)|(mode<<4)|api);
    record(a!=INVALID_SOCKET&&b!=INVALID_SOCKET&&client!=INVALID_SOCKET);
    outcome(local(a,family,&first));outcome(local(b,family,&second));outcome(local(client,family,&self));
    record(port_of(&first));record(port_of(&second));record(port_of(&self));
    outcome(ioctlsocket(client,FIONBIO,&nonblocking));
    record(mode!=0);
    if(mode)outcome(WSAIoctl(client,SIO_UDP_CONNRESET,&reset,sizeof(reset),0,0,&returned,0,0));
    else {record(0);record(0);}
    record(returned);
    if(api)outcome(WSAIoctl(client,SIO_GET_EXTENSION_FUNCTION_POINTER,&extension,sizeof(extension),&receive_message,sizeof(receive_message),&returned,0,0));
    else {record(0);record(0);}
    record(api?receive_message!=0:0);
    outcome(sendto(client,"a",1,0,(struct sockaddr*)&first,size_for(family)));
    wait_socket(a,300,0);outcome(recvfrom(a,(char*)payload,sizeof(payload),0,0,0));
    outcome(sendto(client,"b",1,0,(struct sockaddr*)&second,size_for(family)));
    wait_socket(b,300,0);outcome(recvfrom(b,(char*)payload,sizeof(payload),0,0,0));
    outcome(closesocket(a));
    outcome(sendto(client,"x",1,0,(struct sockaddr*)&first,size_for(family)));
    wait_socket(client,250,1);
    fill(name,sizeof(name),0xa5);fill(payload,sizeof(payload),0xa5);fill(control,sizeof(control),0xa5);fill(&message,sizeof(message),0);
    buffer.buf=(char*)payload;buffer.len=sizeof(payload);message.name=(struct sockaddr*)name;message.namelen=sizeof(name);
    message.lpBuffers=&buffer;message.dwBufferCount=1;message.Control.buf=(char*)control;message.Control.len=sizeof(control);
    if(api)result=receive_message?receive_message(client,&message,&bytes,0,0):SOCKET_ERROR;
    else result=recvfrom(client,(char*)payload,sizeof(payload),0,(struct sockaddr*)name,&name_length);
    outcome(result);record(bytes);record(api?message.namelen:name_length);record(message.dwFlags);record(message.Control.len);
    record(message.name==(struct sockaddr*)name);record(message.Control.buf==(char*)control);record(buffer.len);record(message.dwBufferCount);
    words(name,sizeof(name));words(payload,sizeof(payload));words(control,sizeof(control));
    outcome(sendto(b,"B",1,0,(struct sockaddr*)&self,size_for(family)));
    wait_socket(client,300,1);name_length=sizeof(name);fill(name,sizeof(name),0xc3);fill(payload,sizeof(payload),0xc3);
    result=recvfrom(client,(char*)payload,sizeof(payload),0,(struct sockaddr*)name,&name_length);outcome(result);
    record(result==1&&payload[0]=='B');record(name_length);record(((struct sockaddr*)name)->sa_family);
    record(port_of((SOCKADDR_STORAGE*)name)==port_of(&second));
    outcome(closesocket(b));outcome(closesocket(client));
}
void entry(void){
    WSADATA data;DWORD written=0;HANDLE out;int family,mode,api;
    record(WSAStartup(MAKEWORD(2,2),&data));
    for(family=0;family<2;family++)for(mode=0;mode<3;mode++)for(api=0;api<2;api++)probe(family?AF_INET6:AF_INET,mode,api);
    record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    out=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(out!=INVALID_HANDLE_VALUE){WriteFile(out,(const void*)oracle_results,count*4,&written,0);CloseHandle(out);}
    ExitProcess(out==INVALID_HANDLE_VALUE||written!=count*4?1:0);
}
