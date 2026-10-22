/* Finite causal SEND_COMPLETE oracle: one process, manual callbacks, repeated
 * processing batches, mixed delivery flags and a replacement peer. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#define CAPACITY 32
static DWORD words[1024],count=3,player,creates,destroys,thread,wrong_thread,bad_receive;
static DWORD payload[CAPACITY],received[CAPACITY],completed[CAPACITY],result[CAPACITY],rtt[CAPACITY],retry[CAPACITY],flags[CAPACITY],match_handle[CAPACITY],match_descriptor[CAPACITY];
static DPN_BUFFER_DESC buffers[CAPACITY];
static DPNHANDLE handles[CAPACITY];
static GUID pool_class={0xfc47060e,0x6153,0x4b34,{0xb9,0x75,0x8e,0x41,0x21,0xeb,0x7f,0x3c}};
static GUID pool_iid={0x0d22ee73,0x4a46,0x4a0d,{0x89,0xb2,0x04,0x5b,0x4d,0x66,0x64,0x25}};
static void save(const char *name){
 HANDLE file;DWORD wrote;words[0]=0x42534c4e;words[1]=count;words[2]=ORACLE_NONCE;
 file=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(file!=INVALID_HANDLE_VALUE){WriteFile(file,words,count*4,&wrote,0);CloseHandle(file);}
}
static void record(DWORD value){words[count++]=value;save("send-operation-progress.bin");}
static HRESULT WINAPI pool_callback(void *context,DWORD message,void *data){(void)context;(void)message;(void)data;return S_OK;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
 DWORD i;(void)context;if(GetCurrentThreadId()!=thread)wrong_thread++;
 if(message==DPN_MSGID_CREATE_PLAYER){creates++;player=((DPNMSG_CREATE_PLAYER*)data)->dpnidPlayer;}
 if(message==DPN_MSGID_DESTROY_PLAYER)destroys++;
 if(message==DPN_MSGID_RECEIVE){
  DPNMSG_RECEIVE *m=data;i=m->dwReceiveDataSize==4?*(DWORD*)m->pReceiveData-0x12340000:CAPACITY;
  if(i<CAPACITY)received[i]++;else bad_receive++;
 }
 if(message==DPN_MSGID_SEND_COMPLETE){
  DPNMSG_SEND_COMPLETE *m=data;i=(DWORD)m->pvUserContext-0x2000;
  if(i<CAPACITY){completed[i]++;result[i]=m->hResultCode;rtt[i]=m->dwFirstFrameRTT;retry[i]=m->dwFirstFrameRetryCount;flags[i]=m->dwSendCompleteFlags;
   match_handle[i]=m->hAsyncOp;match_descriptor[i]=m->pBuffers&&m->dwNumBuffers==1&&m->pBuffers[0].dwBufferSize==4&&m->pBuffers[0].pBufferData==(BYTE*)&payload[i];
  }
 }
 return S_OK;
}
static IDirectPlay8Peer *host(IDirectPlay8ThreadPool *pool,IDirectPlay8Address *address,DWORD sequence){
 IDirectPlay8Peer *peer=0;DPN_APPLICATION_DESC desc;DWORD i;HRESULT hr;
 hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr))return 0;
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;
 desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;desc.guidApplication.Data2=(WORD)sequence;
 record(IDirectPlay8Peer_Host(peer,&desc,&address,1,0,0,0,0));record(IDirectPlay8ThreadPool_DoWork(pool,0,0));record(creates);return peer;
}
static void send(IDirectPlay8Peer *peer,DWORD index,DWORD options){
 payload[index]=0x12340000+index;buffers[index].dwBufferSize=4;buffers[index].pBufferData=(BYTE*)&payload[index];
 handles[index]=0;record(IDirectPlay8Peer_SendTo(peer,player,&buffers[index],1,0,(void*)(0x2000+index),&handles[index],options));
 record(handles[index]!=0);record(completed[index]);
}
static void work(IDirectPlay8ThreadPool *pool,DWORD first,DWORD length){
 DWORD i;record(IDirectPlay8ThreadPool_DoWork(pool,0,0));
 for(i=first;i<first+length;i++){
  record(received[i]);record(completed[i]);record(result[i]);record(rtt[i]);record(retry[i]);record(flags[i]);
  record(completed[i]&&match_handle[i]==handles[i]);record(match_descriptor[i]);
 }
}
void entry(void){
 IDirectPlay8ThreadPool *pool=0;IDirectPlay8Address *address=0;IDirectPlay8Peer *peer=0;HRESULT hr;thread=GetCurrentThreadId();
 CoInitialize(0);hr=CoCreateInstance(&pool_class,0,CLSCTX_INPROC_SERVER,&pool_iid,(void**)&pool);record(hr);if(FAILED(hr))goto done;
 record(IDirectPlay8ThreadPool_Initialize(pool,0,pool_callback,0));record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));
 hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&address);record(hr);if(FAILED(hr))goto done;
 record(IDirectPlay8Address_SetSP(address,&CLSID_DP8SP_TCPIP));peer=host(pool,address,1);if(!peer)goto done;
 send(peer,0,13);send(peer,1,13);work(pool,0,2);
 send(peer,2,12);send(peer,3,12);work(pool,2,2);
 send(peer,4,1);send(peer,5,13);send(peer,6,1);send(peer,7,13);work(pool,4,4);
 send(peer,8,9);send(peer,9,13);send(peer,10,12);work(pool,8,3);
 send(peer,11,9);work(pool,11,1);record(IDirectPlay8Peer_Close(peer,0));record(destroys);IDirectPlay8Peer_Release(peer);peer=0;
 peer=host(pool,address,2);if(!peer)goto done;send(peer,12,13);send(peer,13,13);work(pool,12,2);
 record(IDirectPlay8Peer_Close(peer,0));record(destroys);record(wrong_thread);record(bad_receive);
done:
 if(peer)IDirectPlay8Peer_Release(peer);if(address)IDirectPlay8Address_Release(address);
 if(pool){record(IDirectPlay8ThreadPool_Close(pool,0));IDirectPlay8ThreadPool_Release(pool);}
 save("lan-oracle.bin");CoUninitialize();ExitProcess(FAILED(hr)?1:0);
}
