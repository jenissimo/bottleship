#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[96];static DWORD count=3;
static HANDLE ready,leave;static DWORD worker_hr,worker_create;
static void record(DWORD value){oracle_results[count++]=value;}
static void snapshot(DWORD phase){record(phase);record(GetModuleHandleA("dplayx.dll")!=0);}
static DWORD WINAPI worker(void*ignored){
    IUnknown*object=0;(void)ignored;worker_hr=CoInitialize(0);
    worker_create=CoCreateInstance(&CLSID_DirectPlay,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4A,(void**)&object);
    if(object)IUnknown_Release(object);SetEvent(ready);WaitForSingleObject(leave,5000);CoUninitialize();return 17;
}
void entry(void){
    DWORD written=0,tid=0,code=0;HANDLE thread,out;IUnknown*object=0;
    snapshot(0);record(CoInitialize(0));record(CoCreateInstance(&CLSID_DirectPlay,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4A,(void**)&object));
    if(object)IUnknown_Release(object);snapshot(1);
    ready=CreateEventA(0,TRUE,FALSE,0);leave=CreateEventA(0,TRUE,FALSE,0);
    thread=CreateThread(0,0,worker,0,0,&tid);record(thread!=0);record(WaitForSingleObject(ready,3000));record(worker_hr);record(worker_create);
    CoUninitialize();snapshot(2);
    SetEvent(leave);record(WaitForSingleObject(thread,3000));record(GetExitCodeThread(thread,&code));record(code);snapshot(3);
    CloseHandle(thread);CloseHandle(ready);CloseHandle(leave);
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    out=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(out!=INVALID_HANDLE_VALUE){WriteFile(out,(const void*)oracle_results,count*4,&written,0);CloseHandle(out);}
    ExitProcess(out==INVALID_HANDLE_VALUE||written!=count*4?1:0);
}
