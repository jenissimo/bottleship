#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport)volatile DWORD oracle_results[64];static DWORD used=3;
static void record(DWORD n){oracle_results[used++]=n;}
static void probe(BOOL wide){SetLastError(0x1234);HANDLE h=wide?CreateFileMappingW(INVALID_HANDLE_VALUE,0,PAGE_READWRITE,0,64,0):CreateFileMappingA(INVALID_HANDLE_VALUE,0,PAGE_READWRITE,0,64,0);record(h!=0);record(GetLastError());BYTE *p=h?MapViewOfFile(h,FILE_MAP_WRITE,0,0,64):0;record(p!=0);BOOL zero=TRUE;if(p){for(DWORD i=0;i<64;i++)zero&=p[i]==0;p[63]=0x52;}record(p&&zero);record(p&&p[63]==0x52);record(p?UnmapViewOfFile(p):FALSE);record(h?CloseHandle(h):FALSE);}
void entry(void){probe(FALSE);probe(TRUE);oracle_results[0]=0x42534c4e;oracle_results[1]=used;oracle_results[2]=ORACLE_NONCE;DWORD n;HANDLE f=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);if(f==INVALID_HANDLE_VALUE||!WriteFile(f,(const void*)oracle_results,used*4,&n,0)||n!=used*4)ExitProcess(1);CloseHandle(f);ExitProcess(0);}
