#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[160];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void result(int value){record(value);record(value<0?WSAGetLastError():0);}
static void query(SOCKET socket,OVERLAPPED*ov,char*data){DWORD bytes=0x11223344,flags=0x55667788;int value=WSAGetOverlappedResult(socket,ov,&bytes,FALSE,&flags);record(value);record(value?0:WSAGetLastError());record(bytes);record(flags);record(data[0]);}
static void probe(int urgent_first){
    SOCKET listener=socket(AF_INET,SOCK_STREAM,6),tx=socket(AF_INET,SOCK_STREAM,6),rx;struct sockaddr_in address;int length=sizeof(address);
    OVERLAPPED normal,urgent;WSABUF nb,ub;char normal_data[2]={0,0},urgent_data[1]={0};DWORD bytes,flags;
    record(urgent_first);zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    result(bind(listener,(struct sockaddr*)&address,sizeof(address)));result(getsockname(listener,(struct sockaddr*)&address,&length));result(listen(listener,1));result(connect(tx,(struct sockaddr*)&address,sizeof(address)));rx=accept(listener,0,0);record(rx!=INVALID_SOCKET);
    zero(&normal,sizeof(normal));zero(&urgent,sizeof(urgent));normal.hEvent=CreateEventA(0,TRUE,FALSE,0);urgent.hEvent=CreateEventA(0,TRUE,FALSE,0);nb.buf=normal_data;nb.len=2;ub.buf=urgent_data;ub.len=1;
    bytes=0;flags=urgent_first?MSG_OOB:0;result(WSARecv(rx,urgent_first?&ub:&nb,1,&bytes,&flags,urgent_first?&urgent:&normal,0));
    bytes=0;flags=urgent_first?0:MSG_OOB;result(WSARecv(rx,urgent_first?&nb:&ub,1,&bytes,&flags,urgent_first?&normal:&urgent,0));
    result(send(tx,"!",1,MSG_OOB));record(WaitForSingleObject(urgent.hEvent,250));record(WaitForSingleObject(normal.hEvent,0));query(rx,&urgent,urgent_data);
    result(send(tx,"ab",2,0));record(WaitForSingleObject(normal.hEvent,1000));record(WaitForSingleObject(urgent.hEvent,1000));query(rx,&normal,normal_data);record(normal_data[1]);query(rx,&urgent,urgent_data);
    closesocket(rx);closesocket(tx);closesocket(listener);CloseHandle(normal.hEvent);CloseHandle(urgent.hEvent);
}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));probe(0);probe(1);record(WSACleanup());finish();}
