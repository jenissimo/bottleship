#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[160];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void check_handle(HANDLE handle){DWORD flags=0xfeed;BOOL value;SetLastError(0x2345);value=GetHandleInformation(handle,&flags);record(value);record(GetLastError());record(flags);}
static void probe(BOOL null_target,DWORD options){
    HANDLE source=CreateIoCompletionPort(INVALID_HANDLE_VALUE,0,0,1),monitor=0,target=0;BOOL value;DWORD error;
    record(null_target);record(options);record(source!=0);
    record(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&monitor,0,FALSE,DUPLICATE_SAME_ACCESS));
    SetLastError(0x1234);
    value=DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),null_target?0:&target,0,TRUE,options);
    error=GetLastError();record(value);record(error);record(target!=0);record(target!=source);
    check_handle(source);
    SetLastError(0x5678);value=PostQueuedCompletionStatus(source,6,41,0);record(value);record(GetLastError());
    SetLastError(0x3456);value=PostQueuedCompletionStatus(monitor,7,42,0);record(value);record(GetLastError());
    if(target){check_handle(target);CloseHandle(target);}
    SetLastError(0x4567);value=CloseHandle(source);record(value);record(GetLastError());
    CloseHandle(monitor);
}
void entry(void){
    HANDLE output;DWORD written;
    probe(TRUE,DUPLICATE_CLOSE_SOURCE);probe(TRUE,DUPLICATE_CLOSE_SOURCE|DUPLICATE_SAME_ACCESS);
    probe(FALSE,DUPLICATE_CLOSE_SOURCE);probe(FALSE,DUPLICATE_CLOSE_SOURCE|DUPLICATE_SAME_ACCESS);
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}
    ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
