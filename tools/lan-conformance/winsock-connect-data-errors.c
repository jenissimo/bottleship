#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE *p=ptr;while(size--)*p++=0;}
static void connect_case(DWORD mode){
    struct sockaddr_in address;SOCKET reserved=socket(AF_INET,SOCK_STREAM,6),source;int size=sizeof(address),value;
    WSABUF caller={3,0},callee={8,0};char buffer[8]={0x55};QOS qos;
    zero(&qos,sizeof(qos));zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    record(bind(reserved,(struct sockaddr*)&address,sizeof(address)));record(getsockname(reserved,(struct sockaddr*)&address,&size));
    if(mode<2)record(listen(reserved,4));else record(0);
    source=socket(AF_INET,mode>=4?SOCK_DGRAM:SOCK_STREAM,mode>=4?17:6);
    if(mode==0||mode==2||mode==4)callee.buf=buffer;
    record(10+mode);SetLastError(0x1234);
    value=WSAConnect(source,(struct sockaddr*)&address,sizeof(address),&caller,&callee,&qos,&qos);
    record(value);record(WSAGetLastError());record(caller.len);record(callee.len);record(buffer[0]);
    closesocket(source);closesocket(reserved);
}
static void unconnected(DWORD type,BOOL receiving){
    SOCKET source=socket(AF_INET,type,type==SOCK_STREAM?6:17);WSABUF data={8,0};int value;
    record(type);record(receiving);SetLastError(0x2345);
    value=receiving?WSARecvDisconnect(source,&data):WSASendDisconnect(source,&data);
    record(value);record(WSAGetLastError());record(data.len);closesocket(source);
}
void entry(void){
    WSADATA data;DWORD index,written;HANDLE output;record(WSAStartup(MAKEWORD(2,2),&data));
    for(index=0;index<6;index++)connect_case(index);
    unconnected(SOCK_STREAM,FALSE);unconnected(SOCK_STREAM,TRUE);unconnected(SOCK_DGRAM,FALSE);unconnected(SOCK_DGRAM,TRUE);
    record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}
    ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
