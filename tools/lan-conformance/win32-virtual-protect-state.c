#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void run(DWORD mode){
 BYTE *base=VirtualAlloc(0,0x3000,mode==4?MEM_RESERVE:MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
 DWORD old=0xfeed,status,last;MEMORY_BASIC_INFORMATION info;
 if(!base)ExitProcess(30);
 if(mode==1||mode==9)VirtualFree(base+0x1000,0x1000,MEM_DECOMMIT);
 if(mode==2)VirtualFree(base,0x1000,MEM_DECOMMIT);
 if(mode==3)VirtualFree(base,0x3000,MEM_DECOMMIT);
 if(mode==5)VirtualFree(base,0,MEM_RELEASE);
 if(mode==9)VirtualProtect(base,0x1000,PAGE_READONLY,&old);
 old=0xfeed;SetLastError(0x3456);
 status=VirtualProtect(base,mode==6?0:mode==7?0x100000:0x2000,mode==8?0x123450:PAGE_NOACCESS,&old);last=GetLastError();
 record(mode);record(status);record(last);record(old);
 VirtualQuery(base,&info,sizeof(info));record(info.State);record(info.Protect);
 VirtualQuery(base+0x1000,&info,sizeof(info));record(info.State);record(info.Protect);
 if(mode!=5)VirtualFree(base,0,MEM_RELEASE);
}
void entry(void){
 DWORD mode,written;HANDLE output;for(mode=0;mode<10;mode++)run(mode);
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
 output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
