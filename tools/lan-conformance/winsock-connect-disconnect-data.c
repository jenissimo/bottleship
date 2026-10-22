#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE *p=ptr;while(size--)*p++=0;}
static void outcome(int value){record(value);record(WSAGetLastError());}
static SOCKET listener(struct sockaddr_in *address){
    SOCKET value=socket(AF_INET,SOCK_STREAM,6);int size=sizeof(*address);
    zero(address,sizeof(*address));address->sin_family=AF_INET;address->sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    record(bind(value,(struct sockaddr*)address,sizeof(*address)));record(getsockname(value,(struct sockaddr*)address,&size));record(listen(value,4));return value;
}
static void connect_case(DWORD mode){
    struct sockaddr_in address,remote;SOCKET server=listener(&address),source=socket(AF_INET,SOCK_STREAM,6),peer;
    WSABUF caller,callee;QOS qos;char returned[8];int size=sizeof(remote);DWORD index;
    zero(&qos,sizeof(qos));for(index=0;index<sizeof(returned);index++)returned[index]=0x55;
    caller.len=mode==1?0:3;caller.buf=mode==1?0:"abc";callee.len=mode==3?0:sizeof(returned);callee.buf=mode==3?0:returned;
    record(10+mode);SetLastError(0x1234);
    {int value=WSAConnect(source,(struct sockaddr*)&address,sizeof(address),
        mode==1||mode==2||mode==5?&caller:0,mode==3||mode==4||mode==5?&callee:0,mode==6?&qos:0,mode==7?&qos:0);
        outcome(value);record(caller.len);record(callee.len);record(returned[0]);
        record(getpeername(source,(struct sockaddr*)&remote,&size)==0);
        if(value==0){peer=accept(server,0,0);record(peer!=INVALID_SOCKET);closesocket(peer);}else record(0);
    }
    closesocket(source);closesocket(server);
}
static void disconnect_case(BOOL receiving,DWORD mode){
    struct sockaddr_in address;SOCKET server=listener(&address),source=socket(AF_INET,SOCK_STREAM,6),peer;
    WSABUF data;char buffer[8];int value,timeout=1000;DWORD index;
    record((receiving?30:20)+mode);record(connect(source,(struct sockaddr*)&address,sizeof(address)));peer=accept(server,0,0);record(peer!=INVALID_SOCKET);
    setsockopt(source,SOL_SOCKET,SO_RCVTIMEO,(const char*)&timeout,4);setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char*)&timeout,4);
    for(index=0;index<sizeof(buffer);index++)buffer[index]=0x55;
    data.len=mode==1?0:3;data.buf=mode==1?0:buffer;
    if(receiving)record(shutdown(peer,SD_SEND));
    SetLastError(0x2345);value=receiving?WSARecvDisconnect(source,mode?&data:0):WSASendDisconnect(source,mode?&data:0);
    outcome(value);record(data.len);record(buffer[0]);
    if(receiving){SetLastError(0x3456);outcome(recv(source,buffer,1,0));}
    SetLastError(0x4567);outcome(send(source,"z",1,0));
    SetLastError(0x5678);value=recv(peer,buffer,1,0);outcome(value);record(value>0?buffer[0]:0);
    closesocket(source);closesocket(peer);closesocket(server);
}
void entry(void){
    WSADATA data;DWORD index,written;HANDLE output;record(WSAStartup(MAKEWORD(2,2),&data));
    for(index=0;index<8;index++)connect_case(index);
    for(index=0;index<3;index++)disconnect_case(FALSE,index);
    for(index=0;index<3;index++)disconnect_case(TRUE,index);
    record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}
    ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
