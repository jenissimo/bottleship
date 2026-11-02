#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef RETENTION_MODE
#define RETENTION_MODE 0
#endif
#if RETENTION_MODE == 2
static HRESULT (WINAPI * volatile imported_entry)(LPDPENUMDPCALLBACKA, LPVOID) = DirectPlayEnumerateA;
#endif
__declspec(dllexport) volatile DWORD oracle_results[128]; static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void snapshot(DWORD phase){record(phase);record(GetModuleHandleA("dplayx.dll")!=0);record(GetModuleHandleW(L"dplayx.dll")!=0);}
void entry(void){
    IUnknown *object=0; HMODULE first=0,second=0; DWORD written=0; HANDLE out; HRESULT hr;
    record(RETENTION_MODE);
#if RETENTION_MODE == 2
    record(imported_entry!=0);
#else
    record(0);
#endif
    snapshot(0);
#if RETENTION_MODE == 1
    first=LoadLibraryA("dplayx.dll");second=LoadLibraryW(L"dplayx.dll");record(first!=0);record(first==second);
#else
    record(0);record(0);
#endif
    snapshot(1);
    record(CoInitialize(0));record(CoInitialize(0));
    hr=CoCreateInstance(&CLSID_DirectPlay,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4A,(void**)&object);
    record(hr);record(object!=0);snapshot(2);
    if(object)IUnknown_Release(object);
    CoUninitialize();snapshot(3);
    CoUninitialize();snapshot(4);
#if RETENTION_MODE == 1
    record(FreeLibrary(first));snapshot(5);
    record(FreeLibrary(second));snapshot(6);
#else
    record(0);snapshot(5);record(0);snapshot(6);
#endif
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    out=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(out!=INVALID_HANDLE_VALUE){WriteFile(out,(const void*)oracle_results,count*4,&written,0);CloseHandle(out);}
    ExitProcess(out==INVALID_HANDLE_VALUE||written!=count*4?1:0);
}
