#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void status(BOOL value){record(value);record(GetLastError());}
static void query(void *address,void *allocation){
 MEMORY_BASIC_INFORMATION info;SIZE_T result=VirtualQuery(address,&info,sizeof(info));
 record((DWORD)result);record(info.State);record(info.Protect);record(info.AllocationProtect);
 record(info.BaseAddress==address);record(info.AllocationBase==allocation);
 record(info.State==MEM_FREE?0:(DWORD)info.RegionSize);
}
static void handle_output(HANDLE handle,DWORD *output,BOOL readable){
 SetLastError(0x2345);status(GetHandleInformation(handle,output));
 record(readable?*output:0xfeed);
}
void entry(void){
 HANDLE event=CreateEventA(0,TRUE,FALSE,0),file;DWORD written,old;
 BYTE *base=VirtualAlloc(0,0x3000,MEM_RESERVE,PAGE_READWRITE),*middle=base+0x1000;
 record(event!=0);record(base!=0);query(base,base);
 record(VirtualAlloc(middle,0x1000,MEM_COMMIT,PAGE_READWRITE)==middle);
 query(base,base);query(middle,base);query(base+0x2000,base);
 *(DWORD*)middle=0xa5a5a5a5;handle_output(event,(DWORD*)middle,TRUE);
 SetLastError(0x3456);status(VirtualFree(middle,0x1000,MEM_DECOMMIT));
 query(base,base);query(middle,base);
 old=0xfeed;SetLastError(0x4567);status(VirtualProtect(middle,0x1000,PAGE_READWRITE,&old));record(old);
 record(VirtualAlloc(middle,0x1000,MEM_COMMIT,PAGE_READWRITE)==middle);
 record(*(DWORD*)middle);query(middle,base);handle_output(event,(DWORD*)middle,TRUE);
 *(DWORD*)middle=0x11223344;
 record(VirtualAlloc(base,0x3000,MEM_COMMIT,PAGE_READONLY)==base);
 query(base,base);query(middle,base);query(base+0x2000,base);record(*(DWORD*)middle);
 SetLastError(0x5678);status(VirtualFree(base,0,MEM_RELEASE));
 query(base,0);CloseHandle(event);
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
 file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}
 ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
