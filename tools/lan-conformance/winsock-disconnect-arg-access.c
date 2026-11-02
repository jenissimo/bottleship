#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[2048];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE *p=ptr;while(size--)*p++=0;}
static void probe(int family,int type,BOOL inbound,DWORD mode){
    SOCKET server=socket(family,type,type==SOCK_STREAM?6:17),source=socket(family,type,type==SOCK_STREAM?6:17),peer;
    struct sockaddr_storage address;int size,value,error,timeout=1000;DWORD protect;char byte=0;
    WSABUF *data=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);BYTE *payload=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
    zero(&address,sizeof(address));payload[0]=0x55;data->len=mode==5||mode==7?0:8;data->buf=mode==6?0:(char*)payload;
    if(family==AF_INET){struct sockaddr_in*a=(struct sockaddr_in*)&address;a->sin_family=AF_INET;a->sin_addr.s_addr=htonl(INADDR_LOOPBACK);size=sizeof(*a);}
    else{struct sockaddr_in6*a=(struct sockaddr_in6*)&address;a->sin6_family=AF_INET6;a->sin6_addr.s6_addr[15]=1;size=sizeof(*a);}
    record(family);record(type);record(inbound);record(mode);record(bind(server,(struct sockaddr*)&address,size));record(getsockname(server,(struct sockaddr*)&address,&size));
    if(type==SOCK_STREAM)record(listen(server,4));else record(0);
    record(connect(source,(struct sockaddr*)&address,size));peer=type==SOCK_STREAM?accept(server,0,0):server;
    if(inbound&&type==SOCK_STREAM)record(shutdown(peer,SD_SEND));else record(0);
    if(mode==1||mode==7)VirtualProtect(data,4096,PAGE_READONLY,&protect);
    if(mode==2)VirtualProtect(data,4096,PAGE_NOACCESS,&protect);
    if(mode==3||mode==5)VirtualProtect(payload,4096,PAGE_NOACCESS,&protect);
    if(mode==4)VirtualProtect(payload,4096,PAGE_READONLY,&protect);
    SetLastError(0x1234);value=inbound?WSARecvDisconnect(source,mode?data:0):WSASendDisconnect(source,mode?data:0);error=WSAGetLastError();
    record(value);record(error);record(mode==2?0xfeed:data->len);
    SetLastError(0x2345);value=send(source,"z",1,0);record(value);record(WSAGetLastError());
    u_long nonblock=1;ioctlsocket(source,FIONBIO,&nonblock);SetLastError(0x3456);value=recv(source,&byte,1,0);record(value);record(WSAGetLastError());
    record(mode==3||mode==5?0x55:payload[0]);
    closesocket(source);if(type==SOCK_STREAM)closesocket(peer);closesocket(server);VirtualFree(data,0,MEM_RELEASE);VirtualFree(payload,0,MEM_RELEASE);
}
void entry(void){WSADATA data;DWORD family,type,inbound,mode,written;HANDLE file;record(WSAStartup(MAKEWORD(2,2),&data));
    for(family=0;family<2;family++)for(type=1;type<=2;type++)for(inbound=0;inbound<2;inbound++)for(mode=0;mode<8;mode++)probe(family?AF_INET6:AF_INET,type,inbound,mode);
    record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
