#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <mswsock.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#define TOTAL (512*1024)
__declspec(dllexport) volatile DWORD oracle_results[256];static DWORD count=3;
static BYTE payload[TOTAL],received[16384];
static const GUID accept_id=WSAID_ACCEPTEX,connect_id=WSAID_CONNECTEX,transmit_id=WSAID_TRANSMITFILE;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void outcome(int value){record(value);record(value<0?WSAGetLastError():0);}
static void load(SOCKET socket,const GUID*id,void*target){DWORD size=0;outcome(WSAIoctl(socket,SIO_GET_EXTENSION_FUNCTION_POINTER,(void*)id,sizeof(*id),target,4,&size,0,0));record(size);}
static SOCKET duplicate(SOCKET source){WSAPROTOCOL_INFOA info;outcome(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));return (SOCKET)info.dwProviderReserved;}
static SOCKET listen_at(struct sockaddr_in*address){SOCKET listener=socket(AF_INET,SOCK_STREAM,6);int size=sizeof(*address),limit=4096;
    zero(address,sizeof(*address));address->sin_family=AF_INET;address->sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    outcome(setsockopt(listener,SOL_SOCKET,SO_RCVBUF,(const char*)&limit,4));outcome(bind(listener,(struct sockaddr*)address,sizeof(*address)));
    outcome(getsockname(listener,(struct sockaddr*)address,&size));outcome(listen(listener,4));return listener;
}
static void accept_case(DWORD mode){
    struct sockaddr_in address;SOCKET listener=listen_at(&address),target=socket(AF_INET,SOCK_STREAM,6),client=socket(AF_INET,SOCK_STREAM,6);
    SOCKET raw_listener=duplicate(listener),raw_target=duplicate(target);LPFN_ACCEPTEX accept_fn;OVERLAPPED ov;DWORD bytes=0xfeed,flags=0;BOOL value;char output[68]={0},reply=0;
    record(10+mode);load(listener,&accept_id,&accept_fn);zero(&ov,sizeof(ov));ov.hEvent=CreateEventA(0,TRUE,FALSE,0);
    value=accept_fn(raw_listener,raw_target,output,4,32,32,&bytes,&ov);record(value);record(value?0:WSAGetLastError());
    if(mode!=1)outcome(closesocket(raw_listener));if(mode!=0)outcome(closesocket(raw_target));
    record(WaitForSingleObject(ov.hEvent,50));
    outcome(connect(client,(struct sockaddr*)&address,sizeof(address)));outcome(send(client,"abc",3,0));
    record(WaitForSingleObject(ov.hEvent,1000));record(ov.Internal);record(ov.InternalHigh);record(output[0]);record(output[2]);
    SetLastError(0x1234);value=WSAGetOverlappedResult(target,&ov,&bytes,FALSE,&flags);record(value);record(GetLastError());record(bytes);record(flags);
    {struct sockaddr_in before;int size=sizeof(before);outcome(getsockname(target,(struct sockaddr*)&before,&size));}
    outcome(setsockopt(target,SOL_SOCKET,SO_UPDATE_ACCEPT_CONTEXT,(const char*)&listener,sizeof(listener)));
    outcome(send(target,"z",1,0));outcome(recv(client,&reply,1,0));record(reply);
    if(mode==0)closesocket(raw_target);if(mode==1)closesocket(raw_listener);
    closesocket(client);closesocket(target);closesocket(listener);CloseHandle(ov.hEvent);
}
static void drain(SOCKET peer){
    DWORD total=0,hash=2166136261u;int amount,index,timeout=2000;
    setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char*)&timeout,4);
    while(total<TOTAL){amount=recv(peer,(char*)received,sizeof(received),0);if(amount<=0){outcome(amount);break;}for(index=0;index<amount;index++)hash=(hash^received[index])*16777619u;total+=amount;}
    record(total);record(hash);
}
static void connect_case(void){
    struct sockaddr_in address,any;SOCKET listener=listen_at(&address),source=socket(AF_INET,SOCK_STREAM,6),raw,peer;LPFN_CONNECTEX connect_fn;
    OVERLAPPED ov;DWORD bytes=0xfeed,flags=0;int limit=4096;BOOL value;
    record(20);zero(&any,sizeof(any));any.sin_family=AF_INET;outcome(bind(source,(struct sockaddr*)&any,sizeof(any)));
    outcome(setsockopt(source,SOL_SOCKET,SO_SNDBUF,(const char*)&limit,4));raw=duplicate(source);load(raw,&connect_id,&connect_fn);
    zero(&ov,sizeof(ov));ov.hEvent=CreateEventA(0,TRUE,FALSE,0);value=connect_fn(raw,(struct sockaddr*)&address,sizeof(address),payload,TOTAL,&bytes,&ov);
    record(value||WSAGetLastError()==WSA_IO_PENDING);outcome(closesocket(raw));peer=accept(listener,0,0);record(peer!=INVALID_SOCKET);
    drain(peer);record(WaitForSingleObject(ov.hEvent,1000));record(ov.Internal);record(ov.InternalHigh);
    SetLastError(0x2345);value=WSAGetOverlappedResult(source,&ov,&bytes,FALSE,&flags);record(value);record(GetLastError());record(bytes);record(flags);
    {struct sockaddr_in before;int size=sizeof(before);outcome(getsockname(source,(struct sockaddr*)&before,&size));}
    outcome(setsockopt(source,SOL_SOCKET,SO_UPDATE_CONNECT_CONTEXT,0,0));
    closesocket(peer);closesocket(source);closesocket(listener);CloseHandle(ov.hEvent);
}
static void transmit_case(void){
    struct sockaddr_in address;SOCKET listener=listen_at(&address),source=socket(AF_INET,SOCK_STREAM,6),raw,peer;LPFN_TRANSMITFILE transmit_fn;
    OVERLAPPED ov;DWORD bytes=0xfeed,flags=0,written=0;int limit=4096;BOOL value;HANDLE file;
    record(30);outcome(connect(source,(struct sockaddr*)&address,sizeof(address)));peer=accept(listener,0,0);record(peer!=INVALID_SOCKET);
    outcome(setsockopt(source,SOL_SOCKET,SO_SNDBUF,(const char*)&limit,4));raw=duplicate(source);load(raw,&transmit_id,&transmit_fn);
    file=CreateFileA("lan-transmit-alias.bin",GENERIC_READ|GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);record(file!=INVALID_HANDLE_VALUE);
    record(WriteFile(file,payload,TOTAL,&written,0));record(written);record(SetFilePointer(file,0,0,FILE_BEGIN));
    zero(&ov,sizeof(ov));ov.hEvent=CreateEventA(0,TRUE,FALSE,0);value=transmit_fn(raw,file,TOTAL,0,&ov,0,0);
    record(value||WSAGetLastError()==WSA_IO_PENDING);outcome(closesocket(raw));drain(peer);
    record(WaitForSingleObject(ov.hEvent,1000));record(ov.Internal);record(ov.InternalHigh);
    SetLastError(0x3456);value=WSAGetOverlappedResult(source,&ov,&bytes,FALSE,&flags);record(value);record(GetLastError());record(bytes);record(flags);
    CloseHandle(file);closesocket(peer);closesocket(source);closesocket(listener);CloseHandle(ov.hEvent);
}
void entry(void){WSADATA data;DWORD index,written;HANDLE output;for(index=0;index<TOTAL;index++)payload[index]=(BYTE)(index%251);
    record(WSAStartup(MAKEWORD(2,2),&data));accept_case(0);accept_case(1);accept_case(2);connect_case();transmit_case();record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
