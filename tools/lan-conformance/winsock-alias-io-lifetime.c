#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void outcome(int value){record(value);record(value<0?WSAGetLastError():0);}
static void probe(DWORD mode){
    SOCKET source=socket(AF_INET,SOCK_DGRAM,17),peer=socket(AF_INET,SOCK_DGRAM,17),raw;
    WSAPROTOCOL_INFOA info;struct sockaddr_in address;OVERLAPPED ov;WSABUF vector;
    DWORD bytes=0xfeed,flags=0,nonblocking=1;int size=sizeof(address),value;char buffer[8]={0},other[8]={0};
    record(mode);zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    outcome(bind(source,(struct sockaddr*)&address,sizeof(address)));outcome(getsockname(source,(struct sockaddr*)&address,&size));
    outcome(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));raw=(SOCKET)info.dwProviderReserved;
    zero(&ov,sizeof(ov));ov.hEvent=CreateEventA(0,TRUE,FALSE,0);
    SetLastError(0x1234);
    if(mode<2)value=ReadFile((HANDLE)raw,buffer,sizeof(buffer),&bytes,&ov);
    else{vector.buf=buffer;vector.len=sizeof(buffer);value=WSARecv(raw,&vector,1,&bytes,&flags,&ov,0);}
    record(value);record(GetLastError());record(bytes);record(ov.Internal);record(ov.InternalHigh);
    if(mode==0){SetLastError(0x2345);record(CancelIoEx((HANDLE)source,&ov));record(GetLastError());}
    if(mode==1){record(CloseHandle((HANDLE)raw));SetLastError(0x3456);record(CancelIoEx((HANDLE)source,&ov));record(GetLastError());}
    if(mode==2){outcome(closesocket(raw));}
    if(mode==3){outcome(closesocket(source));}
    if(mode==4){outcome(closesocket(source));outcome(closesocket(raw));}
    record(WaitForSingleObject(ov.hEvent,100));record(ov.Internal);record(ov.InternalHigh);
    outcome(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));
    record(WaitForSingleObject(ov.hEvent,1000));record(ov.Internal);record(ov.InternalHigh);record(buffer[0]);record(buffer[2]);
    if(mode!=3&&mode!=4){
#ifdef ORACLE_WAIT_CANCELLED_PACKET
        if(mode<2){fd_set ready;struct timeval timeout;FD_ZERO(&ready);FD_SET(source,&ready);timeout.tv_sec=1;timeout.tv_usec=0;outcome(select(0,&ready,0,0,&timeout));record(ready.fd_count==1&&ready.fd_array[0]==source);}
#endif
        ioctlsocket(source,FIONBIO,&nonblocking);outcome(recv(source,other,sizeof(other),0));record(other[0]);record(other[2]);outcome(closesocket(source));}
    if(mode==0||mode==3)outcome(closesocket(raw));
    CloseHandle(ov.hEvent);outcome(closesocket(peer));
}
void entry(void){WSADATA data;DWORD written;HANDLE output;
    record(WSAStartup(MAKEWORD(2,2),&data));probe(0);probe(1);probe(2);probe(3);probe(4);record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
