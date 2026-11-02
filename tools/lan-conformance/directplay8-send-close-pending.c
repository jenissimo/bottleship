/* Native-only pending-send lifecycle probe. Every observation is flushed before
 * entering Close, so a native hang leaves a nonce-specific durable transcript.
 * NT5 reference: dnet/core/common.cpp DN_Close:581 cancels USER_SEND and
 * INTERNAL_SEND; async.cpp:1941 DNCompleteSendHandle calls DNUserSendComplete.
 * Source alone is not the observable Windows contract measured here. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_PENDING_CLOSE_CASE
#define ORACLE_PENDING_CLOSE_CASE 0
#endif
#ifndef ORACLE_PENDING_CLOSE_ORDER
#define ORACLE_PENDING_CLOSE_ORDER 0
#endif
#define SEND_COUNT 16
#define STRINGIFY_1(value) #value
#define STRINGIFY(value) STRINGIFY_1(value)
static DWORD observations[2048], count=3, player, entry_thread, phase;
static DWORD order[64], order_count;
static DWORD creates, destroys, receives, completes, before_close_receives, before_close_completes;
static DWORD wrong_thread, after_close_callbacks, destroy_reason, during_close_receives, during_close_completes;
static DWORD completion_count[SEND_COUNT], completion_hr[SEND_COUNT], completion_size[SEND_COUNT];
static DWORD completion_handle[SEND_COUNT], completion_buffers[SEND_COUNT], completion_null[SEND_COUNT];
static DWORD completion_descriptor[SEND_COUNT], payload[SEND_COUNT];
static DPNHANDLE handles[SEND_COUNT];
static DPN_BUFFER_DESC buffers[SEND_COUNT];
static GUID pool_class={0xfc47060e,0x6153,0x4b34,{0xb9,0x75,0x8e,0x41,0x21,0xeb,0x7f,0x3c}};
static GUID pool_iid={0x0d22ee73,0x4a46,0x4a0d,{0x89,0xb2,0x04,0x5b,0x4d,0x66,0x64,0x25}};
static void save(const char *name) {
    HANDLE file; DWORD wrote;
    observations[0]=0x42534c4e; observations[1]=count; observations[2]=ORACLE_NONCE;
    file=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,observations,count*4,&wrote,0);CloseHandle(file);}
}
static void record(DWORD value) {
    observations[count++]=value;
    save("pending-close-progress-" STRINGIFY(ORACLE_NONCE) ".bin");
}
static HRESULT WINAPI pool_callback(void *context,DWORD message,void *data) {
    (void)context; (void)message; (void)data; return S_OK;
}
static HRESULT WINAPI callback(void *context,DWORD message,void *data) {
    DWORD index;
    (void)context;
    if(ORACLE_PENDING_CLOSE_ORDER&&phase&&order_count<64){
        order[order_count++]=message==DPN_MSGID_SEND_COMPLETE?0x140000+((DWORD)((DPNMSG_SEND_COMPLETE*)data)->pvUserContext-0x2000):message==DPN_MSGID_DESTROY_PLAYER?0x90000:message==DPN_MSGID_RECEIVE?0x110000:message;
    }
    if(GetCurrentThreadId()!=entry_thread)wrong_thread++;
    if(phase==3)after_close_callbacks++;
    if(message==DPN_MSGID_CREATE_PLAYER){creates++;player=((DPNMSG_CREATE_PLAYER*)data)->dpnidPlayer;}
    if(message==DPN_MSGID_DESTROY_PLAYER){destroys++;destroy_reason=((DPNMSG_DESTROY_PLAYER*)data)->dwReason;}
    if(message==DPN_MSGID_RECEIVE){receives++;if(phase==2)during_close_receives++;}
    if(message==DPN_MSGID_SEND_COMPLETE){
        DPNMSG_SEND_COMPLETE *m=data;
        completes++;if(phase==2)during_close_completes++;
        index=(DWORD)m->pvUserContext-0x2000;
        if(index<SEND_COUNT){
            completion_count[index]++;completion_hr[index]=m->hResultCode;completion_size[index]=m->dwSize;
            completion_handle[index]=m->hAsyncOp;
            completion_buffers[index]=m->dwNumBuffers;completion_null[index]=m->pBuffers==0;
            completion_descriptor[index]=m->pBuffers&&m->dwNumBuffers==1
                &&m->pBuffers[0].dwBufferSize==4&&m->pBuffers[0].pBufferData==(BYTE*)&payload[index];
        }
    }
    return S_OK;
}
static void run_case(IDirectPlay8ThreadPool *pool,IDirectPlay8Address *address,DWORD flags,DWORD cancel) {
    IDirectPlay8Peer *peer=0;DPN_APPLICATION_DESC desc;DWORD i;HRESULT hr;
    player=creates=destroys=receives=completes=wrong_thread=after_close_callbacks=destroy_reason=0;
    during_close_receives=during_close_completes=0;phase=0;
    for(i=0;i<SEND_COUNT;i++){
        completion_count[i]=completion_hr[i]=completion_size[i]=completion_handle[i]=0;
        completion_buffers[i]=completion_descriptor[i]=0;completion_null[i]=1;
        payload[i]=0x12340000+i;buffers[i].dwBufferSize=4;buffers[i].pBufferData=(BYTE*)&payload[i];
        handles[i]=0xcccccccc;
    }
    record(flags);record(cancel);
    hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);
    record(hr);if(FAILED(hr))return;
    record(IDirectPlay8Peer_Initialize(peer,0,callback,0));
    for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;
    desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;desc.guidApplication.Data2=(WORD)flags;
    record(IDirectPlay8Peer_Host(peer,&desc,&address,1,0,0,0,0));
    record(creates);record(IDirectPlay8ThreadPool_DoWork(pool,0,0));record(creates);record(player!=0);
    phase=1;order_count=0;
    for(i=0;i<SEND_COUNT;i++){
        record(IDirectPlay8Peer_SendTo(peer,player,&buffers[i],1,0,(void*)(0x2000+i),&handles[i],flags));
        record(handles[i]!=0&&handles[i]!=0xcccccccc);
    }
    Sleep(25);before_close_receives=receives;before_close_completes=completes;
    record(before_close_receives);record(before_close_completes);
    if(cancel){record(IDirectPlay8Peer_CancelAsyncOperation(peer,0,DPNCANCEL_SEND));}
    phase=2;record(0x434c4f53); /* Durable marker immediately before Close. */
    record(IDirectPlay8Peer_Close(peer,0));
    phase=3;
    record(receives);record(completes);record(destroys);record(destroy_reason);
    record(during_close_receives);record(during_close_completes);record(wrong_thread);
    for(i=0;i<SEND_COUNT;i++){
        record(completion_count[i]);record(completion_hr[i]);record(completion_size[i]);
        record(completion_count[i]&&completion_handle[i]==handles[i]);record(completion_buffers[i]);record(completion_null[i]);record(completion_descriptor[i]);
    }
    Sleep(25);record(IDirectPlay8ThreadPool_DoWork(pool,0,0));
    record(receives);record(completes);record(after_close_callbacks);
    if(ORACLE_PENDING_CLOSE_ORDER){record(order_count);for(i=0;i<order_count;i++)record(order[i]);}
    IDirectPlay8Peer_Release(peer);
}
void entry(void) {
    IDirectPlay8ThreadPool *pool=0;IDirectPlay8Address *address=0;HRESULT hr;
    entry_thread=GetCurrentThreadId();
    CoInitialize(0);
    hr=CoCreateInstance(&pool_class,0,CLSCTX_INPROC_SERVER,&pool_iid,(void**)&pool);record(hr);if(FAILED(hr))goto done;
    record(IDirectPlay8ThreadPool_Initialize(pool,0,pool_callback,0));
    record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));
    hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&address);
    record(hr);if(FAILED(hr))goto cleanup;
    record(IDirectPlay8Address_SetSP(address,&CLSID_DP8SP_TCPIP));
    if(!ORACLE_PENDING_CLOSE_CASE||ORACLE_PENDING_CLOSE_CASE==1)run_case(pool,address,DPNSEND_GUARANTEED|DPNSEND_NOCOPY,0);
    if(!ORACLE_PENDING_CLOSE_CASE||ORACLE_PENDING_CLOSE_CASE==2)run_case(pool,address,DPNSEND_GUARANTEED,0);
    if(!ORACLE_PENDING_CLOSE_CASE||ORACLE_PENDING_CLOSE_CASE==3)run_case(pool,address,DPNSEND_NOCOMPLETE,0);
    if(!ORACLE_PENDING_CLOSE_CASE||ORACLE_PENDING_CLOSE_CASE==4)run_case(pool,address,DPNSEND_GUARANTEED|DPNSEND_NOCOPY,1);
    if(!ORACLE_PENDING_CLOSE_CASE||ORACLE_PENDING_CLOSE_CASE==5)run_case(pool,address,DPNSEND_GUARANTEED|DPNSEND_NOCOPY|DPNSEND_COMPLETEONPROCESS,0);
    if(!ORACLE_PENDING_CLOSE_CASE||ORACLE_PENDING_CLOSE_CASE==6)run_case(pool,address,DPNSEND_GUARANTEED|DPNSEND_NOCOPY|DPNSEND_COMPLETEONPROCESS,1);
cleanup:
    if(address)IDirectPlay8Address_Release(address);
    record(IDirectPlay8ThreadPool_Close(pool,0));IDirectPlay8ThreadPool_Release(pool);
done:
    save("lan-oracle.bin");CoUninitialize();ExitProcess(FAILED(hr)?1:0);
}
