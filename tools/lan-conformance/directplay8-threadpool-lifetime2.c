#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3,creates,destroys,thread,recursive,main_id,call_inside,close_inside,set_inside;
static IDirectPlay8ThreadPool *pool;
static void record(DWORD n){oracle_results[count++]=n;}
static HRESULT WINAPI pc(void *c,DWORD m,void *d){(void)c;(void)d;
 if(m==DPN_MSGID_CREATE_THREAD){creates++;thread=GetCurrentThreadId();if(call_inside){recursive=IDirectPlay8ThreadPool_DoWork(pool,0,0);close_inside=IDirectPlay8ThreadPool_Close(pool,0);set_inside=IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0);}}
 if(m==DPN_MSGID_DESTROY_THREAD)destroys++;
 return S_OK;
}
static HRESULT WINAPI cc(void *c,DWORD m,void *d){(void)c;(void)m;(void)d;return S_OK;}
static void finish(void){HANDLE f;DWORD n;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;f=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(f!=INVALID_HANDLE_VALUE){WriteFile(f,(const void*)oracle_results,count*4,&n,0);CloseHandle(f);}ExitProcess(f==INVALID_HANDLE_VALUE?1:0);}
void entry(void){
 IDirectPlay8Peer *peer=0;DWORD n=99;HRESULT hr;main_id=GetCurrentThreadId();CoInitialize(0);
 record(CoCreateInstance(&CLSID_DirectPlay8ThreadPool,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8ThreadPool,(void**)&pool));
 if(!pool)finish();
 record(IDirectPlay8ThreadPool_GetThreadCount(pool,0,0,1));record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xfffffffe,0,1));
 record(IDirectPlay8ThreadPool_Initialize(pool,0,0,1));
 record(CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer));
 if(!peer)finish();
 record(IDirectPlay8ThreadPool_Initialize(pool,0,pc,0));record(IDirectPlay8Peer_Initialize(peer,0,cc,0));
 record(IDirectPlay8ThreadPool_GetThreadCount(pool,0xffffffff,&n,0));record(n>0);record(creates>0);
 record(IDirectPlay8ThreadPool_Close(pool,0));record(destroys>0);
 record(IDirectPlay8ThreadPool_Initialize(pool,0,pc,0));n=99;record(IDirectPlay8ThreadPool_GetThreadCount(pool,0xffffffff,&n,0));record(n>0);
 record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));record(IDirectPlay8Peer_Close(peer,0));IDirectPlay8Peer_Release(peer);
 n=99;record(IDirectPlay8ThreadPool_GetThreadCount(pool,0xffffffff,&n,0));record(n);
 call_inside=1;record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,1,0));record(thread!=main_id);record(recursive);record(close_inside);record(set_inside);
 record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));record(IDirectPlay8ThreadPool_Close(pool,0));IDirectPlay8ThreadPool_Release(pool);CoUninitialize();finish();
}
