#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_SOCKET_FLAGS
#define ORACLE_SOCKET_FLAGS WSA_FLAG_OVERLAPPED
#endif
__declspec(dllexport) volatile DWORD oracle_results[160];
static DWORD count=3,callbacks,callback_error,callback_bytes,callback_flags;
static SOCKET pending_tx;static struct sockaddr_in pending_address;
static DWORD WINAPI sender(LPVOID context){Sleep(50);if((DWORD)context)send(pending_tx,"!",1,MSG_OOB);else sendto(pending_tx,"abc",3,0,(struct sockaddr*)&pending_address,sizeof(pending_address));return 0;}
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void *ptr,DWORD size){unsigned char*p=ptr;while(size--)*p++=0;}
static void CALLBACK complete(DWORD error,DWORD bytes,LPWSAOVERLAPPED ov,DWORD flags){(void)ov;callbacks++;callback_error=error;callback_bytes=bytes;callback_flags=flags;}
static void run_case(int urgent,int pending){
    SOCKET rx,tx,listener=INVALID_SOCKET;HANDLE sender_thread=0;struct sockaddr_in address;WSAOVERLAPPED ov;WSABUF buffer;char data[2]={0,0};DWORD bytes=0,flags=urgent?MSG_OOB:0;int result,length=sizeof(address);
    rx=WSASocketA(AF_INET,urgent?SOCK_STREAM:SOCK_DGRAM,urgent?6:17,0,0,ORACLE_SOCKET_FLAGS);tx=socket(AF_INET,urgent?SOCK_STREAM:SOCK_DGRAM,urgent?6:17);
    clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);bind(rx,(struct sockaddr*)&address,sizeof(address));getsockname(rx,(struct sockaddr*)&address,&length);
    if(urgent){listener=rx;listen(listener,1);connect(tx,(struct sockaddr*)&address,sizeof(address));rx=accept(listener,0,0);}
    if(!pending){if(urgent)send(tx,"!",1,MSG_OOB);else sendto(tx,"abc",3,0,(struct sockaddr*)&address,sizeof(address));Sleep(50);}
    clear_bytes(&ov,sizeof(ov));ov.Offset=0x11223344;ov.OffsetHigh=0x55667788;buffer.buf=data;buffer.len=2;callbacks=0;callback_error=callback_bytes=callback_flags=0x12345678;
    if(pending){pending_tx=tx;pending_address=address;sender_thread=CreateThread(0,0,sender,(LPVOID)(DWORD)urgent,0,0);}
#ifdef ORACLE_USE_EVENT
    ov.hEvent=WSACreateEvent();
    result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,0);
#else
    result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,complete);
#endif
    record(result);record(result<0?WSAGetLastError():0);record(bytes);record(flags);record(ov.Internal);record(ov.InternalHigh);record(ov.Offset);record(ov.OffsetHigh);
#ifdef ORACLE_USE_EVENT
    record(WaitForSingleObject(ov.hEvent,1000));
#else
    record(SleepEx(1000,TRUE));
#endif
    record(callbacks);record(callback_error);record(callback_bytes);record(callback_flags);
    bytes=0x11223344;flags=0x55667788;result=WSAGetOverlappedResult(rx,&ov,&bytes,FALSE,&flags);record(result);record(result?0:WSAGetLastError());record(bytes);record(flags);record(ov.Internal);record(ov.InternalHigh);record(data[0]);record(data[1]);
    if(sender_thread){WaitForSingleObject(sender_thread,1000);CloseHandle(sender_thread);}
    closesocket(rx);closesocket(tx);if(listener!=INVALID_SOCKET)closesocket(listener);
#ifdef ORACLE_USE_EVENT
    WSACloseEvent(ov.hEvent);
#endif
}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));run_case(0,0);run_case(0,1);run_case(1,0);run_case(1,1);record(WSACleanup());finish();}
