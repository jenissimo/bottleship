#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE *p=ptr;while(size--)*p++=0;}
static void probe(int family,BOOL output){
    SOCKET listener=socket(family,SOCK_STREAM,6),source=socket(family,SOCK_STREAM,6),peer;struct sockaddr_storage address;int size,value,timeout=1000;char first=0,bytes[8]={0};WSABUF caller={3,"abc"},callee={8,bytes};
    zero(&address,sizeof(address));
    if(family==AF_INET){struct sockaddr_in*a=(struct sockaddr_in*)&address;a->sin_family=AF_INET;a->sin_addr.s_addr=htonl(INADDR_LOOPBACK);size=sizeof(*a);}
    else{struct sockaddr_in6*a=(struct sockaddr_in6*)&address;a->sin6_family=AF_INET6;a->sin6_addr.s6_addr[15]=1;size=sizeof(*a);}
    record(family);record(output);record(bind(listener,(struct sockaddr*)&address,size));record(getsockname(listener,(struct sockaddr*)&address,&size));record(listen(listener,4));
    SetLastError(0x1234);value=WSAConnect(source,(struct sockaddr*)&address,size,&caller,output?&callee:0,0,0);record(value);record(WSAGetLastError());
    peer=accept(listener,0,0);record(peer!=INVALID_SOCKET);setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char*)&timeout,4);
    record(send(source,"z",1,0));record(recv(peer,&first,1,0));record(first);record(callee.len);record(callee.buf==0);
    closesocket(peer);closesocket(source);closesocket(listener);
}
void entry(void){WSADATA data;DWORD written;HANDLE file;record(WSAStartup(MAKEWORD(2,2),&data));probe(AF_INET,FALSE);probe(AF_INET,TRUE);probe(AF_INET6,FALSE);probe(AF_INET6,TRUE);record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);}
