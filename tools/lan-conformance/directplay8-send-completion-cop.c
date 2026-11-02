/* Native diagnostic: self COMPLETEONPROCESS scatter/gather can fail and leave Close blocked.
 * Durable partial records use a nonce; this probe is not the passing completion conformance fixture. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD observations[256],count=3,player,active_context,callback_handle,callback_size,callback_hr,callback_context,callback_flags,callback_buffers,callback_null,callback_match,callback_time,callback_rtt,callback_retry,total_receives,total_completes;
static volatile DWORD receives,completes;
static BYTE payload[]={7,0,9};static DPN_BUFFER_DESC buffers[2];
#define ORACLE_STRINGIFY_1(value) #value
#define ORACLE_STRINGIFY(value) ORACLE_STRINGIFY_1(value)
static void record(DWORD value){HANDLE file;DWORD wrote;observations[count++]=value;observations[0]=0x42534c4e;observations[1]=count;observations[2]=ORACLE_NONCE;file=CreateFileA("send-progress-" ORACLE_STRINGIFY(ORACLE_NONCE) ".bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,observations,count*4,&wrote,0);CloseHandle(file);}}
static void wait_value(volatile DWORD *value,DWORD target){DWORD begin=GetTickCount();while(*value<target&&GetTickCount()-begin<3000)Sleep(1);}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
 (void)context;
 if(message==DPN_MSGID_CREATE_PLAYER)player=((DPNMSG_CREATE_PLAYER*)data)->dpnidPlayer;
 if(message==DPN_MSGID_RECEIVE){total_receives++;InterlockedIncrement((LONG*)&receives);}
 if(message==DPN_MSGID_SEND_COMPLETE){DPNMSG_SEND_COMPLETE *m=data;callback_handle=m->hAsyncOp;callback_size=m->dwSize;callback_hr=m->hResultCode;callback_context=m->pvUserContext==(void*)active_context;callback_time=m->dwSendTime<10000;callback_flags=m->dwSendCompleteFlags;callback_buffers=m->dwNumBuffers;callback_null=m->pBuffers==0;callback_rtt=m->dwFirstFrameRTT;callback_retry=m->dwFirstFrameRetryCount;callback_match=m->pBuffers&&m->dwNumBuffers==2&&m->pBuffers[0].dwBufferSize==1&&m->pBuffers[0].pBufferData==payload&&m->pBuffers[1].dwBufferSize==2&&m->pBuffers[1].pBufferData==payload+1;total_completes++;InterlockedIncrement((LONG*)&completes);}
 return S_OK;
}
static void run_case(IDirectPlay8Peer *peer,DWORD flags,DWORD index,DWORD buffer_count,DWORD timeout){
 HRESULT hr;DPNHANDLE handle=0xcccccccc;DWORD messages=999,bytes=999,begin;
 receives=completes=callback_handle=callback_size=callback_hr=callback_context=callback_flags=callback_buffers=callback_match=callback_time=callback_rtt=callback_retry=0;callback_null=1;active_context=0x123400+index;
 hr=IDirectPlay8Peer_SendTo(peer,player,buffers,buffer_count,timeout,(void*)active_context,&handle,flags);record(hr);record(handle!=0&&handle!=0xcccccccc);
 if(SUCCEEDED(hr)){begin=GetTickCount();while(!receives&&!(completes&&FAILED(callback_hr))&&GetTickCount()-begin<3000)Sleep(1);if(flags&DPNSEND_NOCOMPLETE)Sleep(20);else wait_value(&completes,1);}
 record(receives);record(completes);record(callback_size);record(callback_hr);record(callback_context);record(completes&&callback_handle==handle);record(callback_flags);record(callback_buffers);record(callback_null);record(callback_match);record(callback_time);record(callback_rtt);record(callback_retry);
 record(IDirectPlay8Peer_GetSendQueueInfo(peer,player,&messages,&bytes,0));record(messages);record(bytes);
}
void entry(void){
 IDirectPlay8Peer *peer=0;IDirectPlay8Address *device=0;DPN_APPLICATION_DESC desc;HRESULT hr;DWORD i,before_receives,before_completes;const DWORD flags[]={0,DPNSEND_NOCOPY,DPNSEND_NOCOMPLETE,DPNSEND_GUARANTEED,DPNSEND_GUARANTEED|DPNSEND_NOCOPY,DPNSEND_GUARANTEED|DPNSEND_COMPLETEONPROCESS};
 CoInitialize(0);hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr))goto finish;
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&device);record(hr);if(FAILED(hr))goto finish;record(IDirectPlay8Address_SetSP(device,&CLSID_DP8SP_TCPIP));
 for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;desc.guidApplication.Data2=0x48a2;hr=IDirectPlay8Peer_Host(peer,&desc,&device,1,0,0,0,0);record(hr);if(FAILED(hr))goto finish;record(player!=0);
 buffers[0].dwBufferSize=1;buffers[0].pBufferData=payload;buffers[1].dwBufferSize=2;buffers[1].pBufferData=payload+1;
 for(i=0;i<sizeof(flags)/sizeof(flags[0]);i++)run_case(peer,flags[i],i,2,0);
 run_case(peer,DPNSEND_GUARANTEED|DPNSEND_COMPLETEONPROCESS,6,1,0);run_case(peer,DPNSEND_GUARANTEED|DPNSEND_COMPLETEONPROCESS,7,2,100);run_case(peer,DPNSEND_GUARANTEED|DPNSEND_COMPLETEONPROCESS,8,1,100);
 record(IDirectPlay8Peer_Close(peer,0));record(total_receives);record(total_completes);before_receives=total_receives;before_completes=total_completes;Sleep(20);record(before_receives==total_receives&&before_completes==total_completes);
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));record(IDirectPlay8Peer_Host(peer,&desc,&device,1,0,0,0,0));run_case(peer,DPNSEND_NOCOPY,9,2,0);
finish:
 if(peer){record(IDirectPlay8Peer_Close(peer,0));IDirectPlay8Peer_Release(peer);}if(device)IDirectPlay8Address_Release(device);observations[0]=0x42534c4e;observations[1]=count;observations[2]=ORACLE_NONCE;
 {HANDLE file;DWORD wrote;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,observations,count*4,&wrote,0);CloseHandle(file);}}
 CoUninitialize();ExitProcess(FAILED(hr)?1:0);
}
