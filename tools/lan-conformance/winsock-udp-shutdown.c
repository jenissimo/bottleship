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
static void probe(int family,DWORD state,DWORD operation){
    SOCKET source=socket(family,SOCK_DGRAM,17),peer=socket(family,SOCK_DGRAM,17);struct sockaddr_storage address,local;int size,value,error;
    char buffer[8]={0};DWORD protect;WSABUF *data=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);u_long nonblock=1;
    zero(&address,sizeof(address));data->len=8;data->buf=buffer;
    if(family==AF_INET){struct sockaddr_in*a=(struct sockaddr_in*)&address;a->sin_family=AF_INET;a->sin_addr.s_addr=htonl(INADDR_LOOPBACK);size=sizeof(*a);}
    else{struct sockaddr_in6*a=(struct sockaddr_in6*)&address;a->sin6_family=AF_INET6;a->sin6_addr.s6_addr[15]=1;size=sizeof(*a);}
    record(family);record(state);record(operation);record(bind(peer,(struct sockaddr*)&address,size));record(getsockname(peer,(struct sockaddr*)&address,&size));
    if(state==1){zero(&local,sizeof(local));((struct sockaddr*)&local)->sa_family=family;record(bind(source,(struct sockaddr*)&local,size));}
    else if(state==2)record(connect(source,(struct sockaddr*)&address,size));else record(0);
    VirtualProtect(data,4096,PAGE_NOACCESS,&protect);SetLastError(0x1234);
    value=operation<3?shutdown(source,operation):operation==3?WSASendDisconnect(source,data):WSARecvDisconnect(source,data);error=WSAGetLastError();
    record(value);record(error);size=sizeof(local);value=getsockname(source,(struct sockaddr*)&local,&size);record(value);record(WSAGetLastError());
    record(!value&&(family==AF_INET?((struct sockaddr_in*)&local)->sin_port:((struct sockaddr_in6*)&local)->sin6_port)!=0);
    SetLastError(0x2345);value=sendto(source,"z",1,0,(struct sockaddr*)&address,size=family==AF_INET?sizeof(struct sockaddr_in):sizeof(struct sockaddr_in6));record(value);record(WSAGetLastError());
    ioctlsocket(source,FIONBIO,&nonblock);SetLastError(0x3456);value=recvfrom(source,buffer,1,0,0,0);record(value);record(WSAGetLastError());
    closesocket(source);closesocket(peer);VirtualFree(data,0,MEM_RELEASE);
}
void entry(void){WSADATA data;DWORD family,state,operation,written;HANDLE file;record(WSAStartup(MAKEWORD(2,2),&data));
    for(family=0;family<2;family++)for(state=0;state<3;state++)for(operation=0;operation<5;operation++)probe(family?AF_INET6:AF_INET,state,operation);
    record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
