#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0600
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[192];
static DWORD count=3;static SOCKET rx;static WSAOVERLAPPED ov;
static HANDLE ready;static volatile LONG waiter_done;static int waiter_result,waiter_error;static DWORD waiter_bytes,waiter_flags;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void *ptr,DWORD size){unsigned char*p=ptr;while(size--)*p++=0;}
static DWORD WINAPI waiter(LPVOID ignored){(void)ignored;SetEvent(ready);waiter_result=WSAGetOverlappedResult(rx,&ov,&waiter_bytes,TRUE,&waiter_flags);waiter_error=waiter_result?0:WSAGetLastError();InterlockedExchange(&waiter_done,1);return 0;}
static void get_result(BOOL wait){DWORD bytes=0x11223344,flags=0x55667788;int result=WSAGetOverlappedResult(rx,&ov,&bytes,wait,&flags);record(result);record(result?0:WSAGetLastError());record(bytes);record(flags);}
static void run_case(int cancel,int event_mode){
    SOCKET tx;struct sockaddr_in address;int length=sizeof(address),result;HANDLE port,thread;DWORD bytes,key;ULONG_PTR completion_key;LPOVERLAPPED completed;char buffer[8];
    rx=socket(AF_INET,SOCK_DGRAM,17);tx=socket(AF_INET,SOCK_DGRAM,17);clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    bind(rx,(struct sockaddr*)&address,sizeof(address));getsockname(rx,(struct sockaddr*)&address,&length);port=CreateIoCompletionPort((HANDLE)rx,0,42,1);record(port!=0);
    clear_bytes(&ov,sizeof(ov));ov.Offset=0x11223344;if(event_mode)ov.hEvent=CreateEventA(0,TRUE,FALSE,0);ready=CreateEventA(0,TRUE,FALSE,0);
    waiter_done=0;waiter_result=-1;waiter_error=-1;waiter_bytes=0x11223344;waiter_flags=0x55667788;
    bytes=0;result=ReadFile((HANDLE)rx,buffer,8,&bytes,&ov);record(result);record(result?0:GetLastError());record(ov.Internal);
    thread=CreateThread(0,0,waiter,0,0,0);WaitForSingleObject(ready,1000);Sleep(50);
    if(cancel){result=CancelIoEx((HANDLE)rx,&ov);record(result);record(result?0:GetLastError());}else{result=sendto(tx,"abc",3,0,(struct sockaddr*)&address,sizeof(address));record(result);record(result<0?WSAGetLastError():0);}
    Sleep(50);get_result(FALSE);record(ov.Internal);record(ov.InternalHigh);record(ov.Offset);
    bytes=0;key=0;completion_key=0;completed=0;result=GetQueuedCompletionStatus(port,&bytes,&completion_key,&completed,1000);record(result);record(result?0:GetLastError());record(bytes);record(completion_key);record(completed==&ov);
    record(ov.Internal);record(ov.InternalHigh);get_result(FALSE);
    record(WaitForSingleObject(thread,100));record(waiter_done);
    if(!waiter_done){record(TerminateThread(thread,0));}else record(1);
    record(waiter_result);record(waiter_error);record(waiter_bytes);record(waiter_flags);get_result(TRUE);
    CloseHandle(thread);CloseHandle(ready);if(event_mode)CloseHandle(ov.hEvent);closesocket(rx);closesocket(tx);CloseHandle(port);
}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));run_case(0,0);run_case(1,0);run_case(0,1);run_case(1,1);record(WSACleanup());finish();}
