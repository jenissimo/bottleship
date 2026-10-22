#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[1024];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE *p=ptr;while(size--)*p++=0;}
static void probe(int family,int type,DWORD mode){
    SOCKET server=socket(family,type,type==SOCK_STREAM?6:17),source=socket(family,type,type==SOCK_STREAM?6:17);
    struct sockaddr_storage address,local;int size,value,error;DWORD protect;WSABUF *callee,caller;
    BYTE *descriptor=VirtualAlloc(0,8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE),*payload=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
    zero(&address,sizeof(address));payload[0]=0x55;
    if(family==AF_INET){struct sockaddr_in *a=(struct sockaddr_in*)&address;a->sin_family=AF_INET;a->sin_addr.s_addr=htonl(INADDR_LOOPBACK);size=sizeof(*a);}
    else{struct sockaddr_in6 *a=(struct sockaddr_in6*)&address;a->sin6_family=AF_INET6;a->sin6_addr.s6_addr[15]=1;size=sizeof(*a);}
    record(family);record(type);record(mode);record(bind(server,(struct sockaddr*)&address,size));record(getsockname(server,(struct sockaddr*)&address,&size));
    if(type==SOCK_STREAM&&mode!=3&&mode!=4)record(listen(server,4));else record(0);
    callee=(LPWSABUF)(descriptor+((mode==5||mode==6)?4092:0));callee->len=mode==1?0:8;callee->buf=mode==2?0:(char*)payload;
    if(mode==1||mode==2||mode==3||mode==6)VirtualProtect(descriptor,4096,PAGE_READONLY,&protect);
    if(mode==5)VirtualProtect(descriptor+4096,4096,PAGE_READONLY,&protect);
    caller.len=8;caller.buf=(char*)payload;
    if(mode==7)VirtualProtect(descriptor,4096,PAGE_NOACCESS,&protect);
    if(mode==8){record(connect(source,(struct sockaddr*)&address,size));VirtualProtect(descriptor,4096,PAGE_NOACCESS,&protect);}else record(0);
    SetLastError(0x1234);value=WSAConnect(source,(struct sockaddr*)&address,size,mode==7?&caller:0,callee,0,0);error=WSAGetLastError();
    record(value);record(error);
    if(mode!=7&&mode!=8){record(callee->len);record(callee->buf==(mode==2?0:(char*)payload));record(callee->buf==0);}else{record(0xfeed);record(0);record(0);}
    size=sizeof(local);record(getpeername(source,(struct sockaddr*)&local,&size)==0);
    size=sizeof(local);value=getsockname(source,(struct sockaddr*)&local,&size);record(value==0);
    if(!value){record(family==AF_INET?((struct sockaddr_in*)&local)->sin_port!=0:((struct sockaddr_in6*)&local)->sin6_port!=0);
        BYTE *ip=family==AF_INET?(BYTE*)&((struct sockaddr_in*)&local)->sin_addr:(BYTE*)&((struct sockaddr_in6*)&local)->sin6_addr;DWORD index,any=0;for(index=0;index<(family==AF_INET?4u:16u);index++)any|=ip[index];record(any==0);
    }else{record(0);record(0);}
    record(payload[0]);closesocket(source);closesocket(server);VirtualFree(descriptor,0,MEM_RELEASE);VirtualFree(payload,0,MEM_RELEASE);
}
void entry(void){WSADATA data;DWORD family,type,mode,written;HANDLE file;record(WSAStartup(MAKEWORD(2,2),&data));
    for(family=0;family<2;family++)for(type=1;type<=2;type++)for(mode=0;mode<9;mode++)probe(family?AF_INET6:AF_INET,type,mode);
    record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
