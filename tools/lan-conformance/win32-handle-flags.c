#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void status(BOOL value){record(value);record(GetLastError());}
static void information(HANDLE handle){DWORD flags=0xfeed;SetLastError(0x2345);BOOL value=GetHandleInformation(handle,&flags);status(value);record(flags);}
static HANDLE make(DWORD kind){return kind?CreateEventA(0,TRUE,FALSE,0):CreateIoCompletionPort(INVALID_HANDLE_VALUE,0,0,1);}
static void flags(DWORD kind){
 HANDLE source=make(kind),target=0;record(kind);record(source!=0);information(source);
 SetLastError(0x3456);status(SetHandleInformation(source,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT));information(source);
 SetLastError(0x4567);status(SetHandleInformation(source,HANDLE_FLAG_PROTECT_FROM_CLOSE,HANDLE_FLAG_PROTECT_FROM_CLOSE));information(source);
 SetLastError(0x5678);status(CloseHandle(source));information(source);
 SetLastError(0x6789);status(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&target,0,TRUE,DUPLICATE_CLOSE_SOURCE|DUPLICATE_SAME_ACCESS));
 record(target!=0);record(target==source);information(source);information(target);
 SetLastError(0x789a);status(SetHandleInformation(target,4,4));information(target);
 SetLastError(0x89ab);status(SetHandleInformation(target,HANDLE_FLAG_INHERIT,0));information(target);
 SetLastError(0x9abc);status(CloseHandle(target));
 SetLastError(0xabcd);status(SetHandleInformation(source,HANDLE_FLAG_PROTECT_FROM_CLOSE,0));information(source);
 SetLastError(0xbcde);status(CloseHandle(source));information(source);
}
static void bad_output(DWORD mode,DWORD options){
 HANDLE source=make(0);DWORD old;DWORD *output=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);*output=0xa5a5a5a5;
 record(mode);record(options);record(source!=0);if(mode==0)VirtualProtect(output,4096,PAGE_READONLY,&old);else VirtualProtect(output,4096,PAGE_NOACCESS,&old);
 SetLastError(0x1234);status(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),mode==2?(HANDLE*)1:(HANDLE*)output,0,TRUE,options));
 if(mode==0)record(*output);else record(0xfeed);
 information(source);SetLastError(0x3456);status(PostQueuedCompletionStatus(source,6,41,0));SetLastError(0x4567);status(CloseHandle(source));VirtualFree(output,0,MEM_RELEASE);
}
void entry(void){HANDLE output;DWORD written,kind,mode,options;for(kind=0;kind<2;kind++)flags(kind);
 for(mode=0;mode<3;mode++)for(options=1;options<=3;options+=2)bad_output(mode,options);
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
 output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
