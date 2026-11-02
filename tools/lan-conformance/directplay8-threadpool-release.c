#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3,creates,destroys,context_ok;
static GUID pool_class={0xfc47060e,0x6153,0x4b34,{0xb9,0x75,0x8e,0x41,0x21,0xeb,0x7f,0x3c}};
static GUID pool_iid={0x0d22ee73,0x4a46,0x4a0d,{0x89,0xb2,0x04,0x5b,0x4d,0x66,0x64,0x25}};
static GUID nat_class={0xe4c1d9a2,0xcbf7,0x48bd,{0x9a,0x69,0x34,0xa5,0x5e,0x0d,0x89,0x41}};
static GUID nat_iid={0xa9e213f2,0x9a60,0x486f,{0xbf,0x3b,0x53,0x40,0x8b,0x6d,0x1c,0xbb}};
static void record(DWORD value){oracle_results[count++]=value;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
    if(message==DPN_MSGID_CREATE_THREAD){DPNMSG_CREATE_THREAD *m=data;creates++;m->pvUserContext=(void *)0x5678;context_ok=context==(void *)0x1234&&m->dwSize==sizeof(*m);}
    if(message==DPN_MSGID_DESTROY_THREAD){DPNMSG_DESTROY_THREAD *m=data;destroys++;context_ok=context_ok&&m->pvUserContext==(void *)0x5678;}
    return S_OK;
}
static void finish(void){
    HANDLE file;DWORD written;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void *)oracle_results,count*4,&written,0);CloseHandle(file);}
    ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
void entry(void){
    IDirectPlay8ThreadPool *pool=0,*other=0;IDirectPlay8NATResolver *nat=0;IUnknown *unknown=0;DWORD threads=99,size=0,items=99;HRESULT hr;
    CoInitialize(0);hr=CoCreateInstance(&pool_class,0,CLSCTX_INPROC_SERVER,&pool_iid,(void **)&pool);record(hr);if(FAILED(hr))finish();
    record(IDirectPlay8ThreadPool_Initialize(pool,(void *)0x1234,callback,0));
    record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,1,0));
    record(IDirectPlay8ThreadPool_Release(pool));record(destroys>0);
    pool=0;record(CoCreateInstance(&pool_class,0,CLSCTX_INPROC_SERVER,&pool_iid,(void **)&pool));
    if(pool){record(IDirectPlay8ThreadPool_Initialize(pool,(void *)0x1234,callback,0));threads=99;
      record(IDirectPlay8ThreadPool_GetThreadCount(pool,0xffffffff,&threads,0));record(threads);
      record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));record(IDirectPlay8ThreadPool_Close(pool,0));IDirectPlay8ThreadPool_Release(pool);}
    CoUninitialize();finish();
}
