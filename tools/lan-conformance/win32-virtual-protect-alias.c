#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void run(DWORD mode){
 BYTE *base=VirtualAlloc(0,0x2000,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
 DWORD scratch=0,status,last,restored;MEMORY_BASIC_INFORMATION first,second;
 DWORD *out;
 if(!base)ExitProcess(30);
 out=(DWORD*)(base+((mode==2||mode==3)?0xffe:mode==5?0x1010:0x10));
 *out=0xdeadbeef;
 if(mode==4)VirtualProtect(base,0x1000,PAGE_READONLY,&scratch);
 if(mode==5)VirtualProtect(base+0x1000,0x1000,PAGE_READONLY,&scratch);
 SetLastError(0x4567);
 status=VirtualProtect(base,mode==3?0x2000:0x1000,
    mode==1||mode==5?PAGE_NOACCESS:mode==4?PAGE_READWRITE:PAGE_READONLY,out);
 last=GetLastError();
 VirtualQuery(base,&first,sizeof(first));VirtualQuery(base+0x1000,&second,sizeof(second));
 restored=VirtualProtect(base,0x2000,PAGE_READWRITE,&scratch);
 if(!restored)ExitProcess(31);
 record(mode);record(status);record(last);record(first.State);record(first.Protect);
 record(second.Protect);record(*out);record(restored);
 VirtualFree(base,0,MEM_RELEASE);
}
void entry(void){
 DWORD mode,written;HANDLE output;for(mode=0;mode<6;mode++)run(mode);
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
 output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}
 ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
