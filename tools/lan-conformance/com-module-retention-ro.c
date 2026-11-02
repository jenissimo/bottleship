#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef REVERSE_ORDER
#define REVERSE_ORDER 0
#endif
typedef HRESULT (WINAPI *RoInit)(UINT);
typedef void (WINAPI *RoLeave)(void);
__declspec(dllexport) volatile DWORD oracle_results[96];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void snapshot(DWORD phase){record(phase);record(GetModuleHandleA("dplayx.dll")!=0);record(GetModuleHandleW(L"dplayx.dll")!=0);}
void entry(void){
    DWORD written=0;HANDLE out;IUnknown*object=0;
    HMODULE module=LoadLibraryA("combase.dll");
    RoInit init=module?(RoInit)GetProcAddress(module,"RoInitialize"):0;
    RoLeave leave=module?(RoLeave)GetProcAddress(module,"RoUninitialize"):0;
    record(REVERSE_ORDER);record(module!=0);record(init!=0);record(leave!=0);snapshot(0);
    if(init&&leave){
#if REVERSE_ORDER
        record(init(0));record(CoInitialize(0));
#else
        record(CoInitialize(0));record(init(0));
#endif
        record(CoCreateInstance(&CLSID_DirectPlay,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4A,(void**)&object));record(object!=0);
        snapshot(1);if(object)IUnknown_Release(object);
#if REVERSE_ORDER
        leave();snapshot(2);CoUninitialize();snapshot(3);
#else
        CoUninitialize();snapshot(2);leave();snapshot(3);
#endif
    }
    if(module)FreeLibrary(module);
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    out=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(out!=INVALID_HANDLE_VALUE){WriteFile(out,(const void*)oracle_results,count*4,&written,0);CloseHandle(out);}
    ExitProcess(out==INVALID_HANDLE_VALUE||written!=count*4?1:0);
}
