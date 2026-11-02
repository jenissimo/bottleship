#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];
static DWORD count=3, callbacks, callback_error, callback_bytes;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *data,DWORD size){BYTE *p=data;while(size--)*p++=0;}
static void WINAPI completed(DWORD error,DWORD bytes,LPOVERLAPPED ov){
    (void)ov;callbacks++;callback_error=error;callback_bytes=bytes;
}
static void run_case(DWORD operation,DWORD mode){
    SOCKET socket_handle;HANDLE event,port=0;OVERLAPPED ov,*packet=(OVERLAPPED*)0x12345678;
    DWORD bytes=0xfeed,queue_bytes=0x9876;ULONG_PTR key=0x7654;BOOL result;char buffer[8];DWORD i;
    record(operation);record(mode);
    socket_handle=socket(AF_INET,operation==2?SOCK_DGRAM:SOCK_STREAM,operation==2?IPPROTO_UDP:IPPROTO_TCP);
    record(socket_handle!=INVALID_SOCKET);
    event=CreateEventA(0,TRUE,TRUE,0);record(event!=0);
    if(mode==1){port=CreateIoCompletionPort((HANDLE)socket_handle,0,73,0);record(port!=0);}
    zero(&ov,sizeof(ov));ov.Internal=0x1234;ov.InternalHigh=0x5678;ov.hEvent=event;
    for(i=0;i<sizeof(buffer);i++)buffer[i]=(char)0xab;
    callbacks=0;callback_error=0x1122;callback_bytes=0x3344;
    SetLastError(0);
    if(mode==2){
        result=operation==0?ReadFileEx((HANDLE)socket_handle,buffer,sizeof(buffer),&ov,completed)
            :WriteFileEx((HANDLE)socket_handle,buffer,sizeof(buffer),&ov,completed);
    }else{
        result=operation==0?ReadFile((HANDLE)socket_handle,buffer,sizeof(buffer),&bytes,&ov)
            :WriteFile((HANDLE)socket_handle,buffer,sizeof(buffer),&bytes,&ov);
    }
    record(result);record(GetLastError());record(bytes);record((DWORD)ov.Internal);record((DWORD)ov.InternalHigh);
    record((BYTE)buffer[0]);record((BYTE)buffer[7]);record(WaitForSingleObject(event,0));
    record(SleepEx(20,TRUE));record(callbacks);record(callback_error);record(callback_bytes);
    if(mode==1){
        SetLastError(0);record(GetQueuedCompletionStatus(port,&queue_bytes,&key,&packet,20));record(GetLastError());
        record(queue_bytes);record((DWORD)key);record(packet==0);record(packet==&ov);
        record((DWORD)ov.Internal);record((DWORD)ov.InternalHigh);
    }
    record(closesocket(socket_handle));CloseHandle(event);if(port)CloseHandle(port);
}
void entry(void){
    WSADATA startup;DWORD operation,mode,written;HANDLE output;
    record(WSAStartup(MAKEWORD(2,2),&startup));
    for(operation=0;operation<3;operation++)for(mode=0;mode<3;mode++)run_case(operation,mode);
    record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}
    ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
