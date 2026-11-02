#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count=3,observations[96],player,groups[2],owners[2],input_context[2],destroy_context[2],destroy_reason[2];
static volatile DWORD created,destroyed;
static void record(DWORD value){observations[count++]=value;}
static void wait_count(volatile DWORD *value,DWORD target){DWORD begin=GetTickCount();while(*value<target&&GetTickCount()-begin<3000)Sleep(1);}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
 (void)context;
 if(message==DPN_MSGID_CREATE_PLAYER){player=((DPNMSG_CREATE_PLAYER*)data)->dpnidPlayer;}
 if(message==DPN_MSGID_CREATE_GROUP){DPNMSG_CREATE_GROUP *m=data;DWORD slot=created;if(slot<2){groups[slot]=m->dpnidGroup;owners[slot]=!m->dpnidOwner?0:m->dpnidOwner==player?1:2;input_context[slot]=m->pvGroupContext==(void*)(0x1111+slot);m->pvGroupContext=(void*)(0x3333+slot);}InterlockedIncrement((LONG*)&created);}
 if(message==DPN_MSGID_DESTROY_GROUP){DPNMSG_DESTROY_GROUP *m=data;DWORD slot;for(slot=0;slot<2;slot++)if(groups[slot]==m->dpnidGroup){destroy_context[slot]=m->pvGroupContext==(void*)(0x3333+slot);destroy_reason[slot]=m->dwReason;}InterlockedIncrement((LONG*)&destroyed);}
 return S_OK;
}
void entry(void){
 IDirectPlay8Peer *peer=0;IDirectPlay8Address *device=0;DPN_APPLICATION_DESC desc;DPN_GROUP_INFO info;BYTE storage[128];DPN_GROUP_INFO *actual=(DPN_GROUP_INFO*)storage;DWORD i,size,capacity;void *context=0;HRESULT hr;WCHAR name[]={'G',0x416,0};
 CoInitialize(0);hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr))goto finish;
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&device);record(hr);if(FAILED(hr))goto finish;
 record(IDirectPlay8Address_SetSP(device,&CLSID_DP8SP_TCPIP));
 for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;desc.guidApplication.Data2=0x47a1;
 hr=IDirectPlay8Peer_Host(peer,&desc,&device,1,0,0,0,0);record(hr);if(FAILED(hr))goto finish;record(player!=0);
 for(i=0;i<sizeof(info);i++)((BYTE*)&info)[i]=0;info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME;info.pwszName=name;
 for(i=0;i<2;i++){info.dwGroupFlags=i?DPNGROUP_AUTODESTRUCT:0;record(IDirectPlay8Peer_CreateGroup(peer,&info,(void*)(0x1111+i),0,0,DPNCREATEGROUP_SYNC));wait_count(&created,i+1);record(created);record(owners[i]);record(input_context[i]);context=0;record(IDirectPlay8Peer_GetGroupContext(peer,groups[i],&context,0));record(context==(void*)(0x3333+i));size=sizeof(storage);actual->dwSize=sizeof(*actual);record(IDirectPlay8Peer_GetGroupInfo(peer,groups[i],actual,&size,0));record(actual->dwGroupFlags);}
 capacity=0;record(IDirectPlay8Peer_EnumPlayersAndGroups(peer,0,&capacity,DPNENUM_GROUPS));record(capacity);
 record(IDirectPlay8Peer_DestroyGroup(peer,groups[0],0,0,DPNDESTROYGROUP_SYNC));wait_count(&destroyed,1);record(destroyed);record(destroy_context[0]);record(destroy_reason[0]);
finish:
 if(peer){record(IDirectPlay8Peer_Close(peer,0));record(destroyed);record(destroy_context[1]);record(destroy_reason[1]);IDirectPlay8Peer_Release(peer);}if(device)IDirectPlay8Address_Release(device);
 observations[0]=0x42534c4e;observations[1]=count;observations[2]=ORACLE_NONCE;{HANDLE file;DWORD wrote;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,observations,count*4,&wrote,0);CloseHandle(file);}}
 CoUninitialize();ExitProcess(FAILED(hr)?1:0);
}
