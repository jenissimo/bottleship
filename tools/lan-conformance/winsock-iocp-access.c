#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];static DWORD count=3;
static void record(DWORD v){oracle_results[count++]=v;}static void status(BOOL v){record(v);record(GetLastError());}
static void probe(DWORD access){HANDLE source=CreateIoCompletionPort(INVALID_HANDLE_VALUE,0,0,1),copy=0,file,result;DWORD bytes=0xfeed;ULONG_PTR key=0xfeed;OVERLAPPED *ov=(OVERLAPPED*)0xfeed;
 record(access);record(source!=0);SetLastError(0x1234);status(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&copy,access,FALSE,0));
 SetLastError(0x2345);status(PostQueuedCompletionStatus(copy,6,41,0));PostQueuedCompletionStatus(source,7,42,0);
 SetLastError(0x3456);status(GetQueuedCompletionStatus(copy,&bytes,&key,&ov,0));record(bytes);record(key);record(ov==0);
 file=CreateFileA("iocp-access.tmp",GENERIC_READ|GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OVERLAPPED|FILE_FLAG_DELETE_ON_CLOSE,0);record(file!=INVALID_HANDLE_VALUE);
 SetLastError(0x4567);result=CreateIoCompletionPort(file,copy,43,0);record(result==copy);record(GetLastError());
 CloseHandle(file);CloseHandle(copy);CloseHandle(source);
}
void entry(void){DWORD access[]={0,1,2,0x20000,0x80000000,0x40000000,0x20000000,0x10000000};DWORD i,written;HANDLE file;for(i=0;i<8;i++)probe(access[i]);
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
