#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count=3,observations[128],responses,host_players;static BOOL host_mode;
static GUID application={ORACLE_NONCE,0x4a18,0x4ea1,{0x90,0x51,0x82,0x43,0xb9,0xc1,0x38,0x62}};
static BYTE response_data[]={0xaa,0,0xbb},app_data[]={3,5,7},payload[4097],player_data[]={1,0,255},updated_data[]={7,0,9};
static IDirectPlay8Peer *current_peer;static volatile DWORD created,destroyed,local_id,remote_id,local_context_ok,receive_count,receive_size,receive_hash,receive_flags,destroy_contexts;static DPNHANDLE receive_handle;static BYTE *receive_pointer;
static DWORD hash_bytes(const BYTE *data,DWORD size){DWORD hash=2166136261U,i;for(i=0;i<size;i++)hash=(hash^data[i])*16777619U;return hash;}
static void record(DWORD value){observations[count++]=value;}
#ifdef ORACLE_GROUPS
static volatile DWORD auto_group,new_group,groups_created,groups_destroyed,group_context_ok,group_destroy_context_ok,group_infos,added_local,removed_local;
static void wait_value(volatile DWORD *value,DWORD target){DWORD begin=GetTickCount();while(*value<target&&GetTickCount()-begin<3000)Sleep(1);}
#endif
static void output(const char *name,const void *data,DWORD size){HANDLE file;DWORD wrote;file=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,data,size,&wrote,0);CloseHandle(file);}}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
 (void)context;
 if(!host_mode&&message==DPN_MSGID_CREATE_PLAYER){DPNMSG_CREATE_PLAYER *m=data;BYTE storage[512];DWORD size=sizeof(storage);DPN_PLAYER_INFO *info=(DPN_PLAYER_INFO*)storage;info->dwSize=sizeof(*info);if(SUCCEEDED(IDirectPlay8Peer_GetPeerInfo(current_peer,m->dpnidPlayer,info,&size,0))){if(info->dwPlayerFlags&DPNPLAYER_LOCAL){local_id=m->dpnidPlayer;local_context_ok=m->pvPlayerContext==(void*)0x1234;m->pvPlayerContext=(void*)0x2345;}else{remote_id=m->dpnidPlayer;m->pvPlayerContext=(void*)0x3456;}}InterlockedIncrement((LONG*)&created);}
 if(!host_mode&&message==DPN_MSGID_DESTROY_PLAYER){DPNMSG_DESTROY_PLAYER *m=data;if(m->dpnidPlayer==local_id&&m->pvPlayerContext==(void*)0x2345)destroy_contexts|=1;if(m->dpnidPlayer==remote_id&&m->pvPlayerContext==(void*)0x3456)destroy_contexts|=2;InterlockedIncrement((LONG*)&destroyed);}
#ifdef ORACLE_GROUPS
 if(host_mode&&message==DPN_MSGID_CREATE_PLAYER)local_id=((DPNMSG_CREATE_PLAYER*)data)->dpnidPlayer;
 if(message==DPN_MSGID_CREATE_GROUP){DPNMSG_CREATE_GROUP *m=data;BYTE storage[512];DWORD size=sizeof(storage);DPN_GROUP_INFO *info=(DPN_GROUP_INFO*)storage;info->dwSize=sizeof(*info);if(host_mode){if(!auto_group)auto_group=m->dpnidGroup;}else if(SUCCEEDED(IDirectPlay8Peer_GetGroupInfo(current_peer,m->dpnidGroup,info,&size,0))){if(info->dwGroupFlags&DPNGROUP_AUTODESTRUCT)auto_group=m->dpnidGroup;else{new_group=m->dpnidGroup;group_context_ok=m->pvGroupContext==(void*)0x7777;m->pvGroupContext=(void*)0x8888;}}InterlockedIncrement((LONG*)&groups_created);}
 if(!host_mode&&message==DPN_MSGID_DESTROY_GROUP){DPNMSG_DESTROY_GROUP *m=data;if(m->dpnidGroup==new_group){group_destroy_context_ok=m->pvGroupContext==(void*)0x8888;InterlockedIncrement((LONG*)&groups_destroyed);}}
 if(!host_mode&&message==DPN_MSGID_GROUP_INFO)InterlockedIncrement((LONG*)&group_infos);
 if(!host_mode&&message==DPN_MSGID_ADD_PLAYER_TO_GROUP){DPNMSG_ADD_PLAYER_TO_GROUP *m=data;if(m->dpnidGroup==new_group&&m->dpnidPlayer==local_id)InterlockedIncrement((LONG*)&added_local);}
 if(!host_mode&&message==DPN_MSGID_REMOVE_PLAYER_FROM_GROUP){DPNMSG_REMOVE_PLAYER_FROM_GROUP *m=data;if(m->dpnidGroup==new_group&&m->dpnidPlayer==local_id)InterlockedIncrement((LONG*)&removed_local);}
#endif
 if(message==DPN_MSGID_RECEIVE){DPNMSG_RECEIVE *m=data;if(host_mode){DPN_BUFFER_DESC buffer;DPNHANDLE operation=0;buffer.pBufferData=m->pReceiveData;buffer.dwBufferSize=m->dwReceiveDataSize;{DWORD detail[3];detail[0]=m->dwReceiveDataSize;detail[1]=m->dpnidSender;detail[2]=IDirectPlay8Peer_SendTo(current_peer,m->dpnidSender,&buffer,1,0,0,&operation,DPNSEND_GUARANTEED);output("wire-host.receive",detail,sizeof(detail));}return S_OK;}receive_pointer=m->pReceiveData;receive_handle=m->hBufferHandle;receive_size=m->dwReceiveDataSize;receive_hash=hash_bytes(m->pReceiveData,m->dwReceiveDataSize);receive_flags=m->dwReceiveFlags;InterlockedIncrement((LONG*)&receive_count);return DPNSUCCESS_PENDING;}
 if(host_mode&&(message==DPN_MSGID_CREATE_PLAYER||message==DPN_MSGID_DESTROY_PLAYER)){if(message==DPN_MSGID_CREATE_PLAYER)host_players++;else if(host_players)host_players--;output("wire-host.players",&host_players,4);}
 if(message==DPN_MSGID_ENUM_HOSTS_QUERY){DPNMSG_ENUM_HOSTS_QUERY *m=data;m->pvResponseData=response_data;m->dwResponseDataSize=sizeof(response_data);}
 if(message==DPN_MSGID_ENUM_HOSTS_RESPONSE){DPNMSG_ENUM_HOSTS_RESPONSE *m=data;DPN_APPLICATION_DESC *d=m->pApplicationDescription;
   responses++;record(d->dwFlags);record(d->dwMaxPlayers);record(d->dwCurrentPlayers);record(d->dwApplicationReservedDataSize);
   record(d->dwApplicationReservedDataSize==3&&((BYTE*)d->pvApplicationReservedData)[0]==3&&((BYTE*)d->pvApplicationReservedData)[2]==7);
   record(m->dwResponseDataSize);record(m->dwResponseDataSize==3&&((BYTE*)m->pvResponseData)[0]==0xaa&&((BYTE*)m->pvResponseData)[2]==0xbb);
   record(d->pwszSessionName&&d->pwszSessionName[0]=='W'&&d->pwszSessionName[4]==0x416);
 }
 return S_OK;
}
#ifdef ORACLE_GROUPS
static void group_scenario(IDirectPlay8Peer *peer){
 BYTE storage[512];DPN_GROUP_INFO *actual=(DPN_GROUP_INFO*)storage,info;DWORD size,n,ids[4],before;void *context=0;WCHAR name[]={'N','e','w',0x416,0};DWORD i;
 wait_value(&groups_created,1);record(groups_created);record(auto_group!=0);
 size=0;record(IDirectPlay8Peer_GetGroupInfo(peer,auto_group,0,&size,0));record(size);
 size=sizeof(storage);actual->dwSize=sizeof(*actual);record(IDirectPlay8Peer_GetGroupInfo(peer,auto_group,actual,&size,0));record(actual->dwInfoFlags);record(actual->dwGroupFlags);record(actual->pwszName&&actual->pwszName[4]==0x416);record(actual->dwDataSize==3&&actual->pvData&&hash_bytes(actual->pvData,3)==hash_bytes(app_data,3));
 n=0;record(IDirectPlay8Peer_EnumGroupMembers(peer,auto_group,0,&n,0));record(n);n=4;record(IDirectPlay8Peer_EnumGroupMembers(peer,auto_group,ids,&n,0));record(n==1&&ids[0]==remote_id);
 for(i=0;i<sizeof(info);i++)((BYTE*)&info)[i]=0;info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME|DPNINFO_DATA;info.pwszName=name;info.pvData=updated_data;info.dwDataSize=3;
 record(IDirectPlay8Peer_CreateGroup(peer,&info,(void*)0x7777,0,0,DPNCREATEGROUP_SYNC));wait_value(&groups_created,2);record(groups_created);record(group_context_ok);
 record(IDirectPlay8Peer_GetGroupContext(peer,new_group,&context,0));record(context==(void*)0x8888);
 size=sizeof(storage);actual->dwSize=sizeof(*actual);record(IDirectPlay8Peer_GetGroupInfo(peer,new_group,actual,&size,0));record(actual->pwszName&&actual->pwszName[3]==0x416);record(actual->dwGroupFlags);record(actual->dwDataSize);
 record(IDirectPlay8Peer_AddPlayerToGroup(peer,new_group,local_id,0,0,DPNADDPLAYERTOGROUP_SYNC));wait_value(&added_local,1);record(added_local);
 n=0;record(IDirectPlay8Peer_EnumGroupMembers(peer,new_group,0,&n,0));record(n);n=4;record(IDirectPlay8Peer_EnumGroupMembers(peer,new_group,ids,&n,0));record(n==1&&ids[0]==local_id);
 info.dwInfoFlags=DPNINFO_DATA;info.pwszName=0;info.pvData=player_data;before=group_infos;record(IDirectPlay8Peer_SetGroupInfo(peer,new_group,&info,0,0,DPNSETGROUPINFO_SYNC));wait_value(&group_infos,before+1);record(group_infos==before+1);
 size=sizeof(storage);actual->dwSize=sizeof(*actual);record(IDirectPlay8Peer_GetGroupInfo(peer,new_group,actual,&size,0));record(actual->pwszName&&actual->pwszName[3]==0x416);record(actual->dwDataSize==3&&actual->pvData&&hash_bytes(actual->pvData,3)==hash_bytes(player_data,3));
 record(IDirectPlay8Peer_RemovePlayerFromGroup(peer,new_group,local_id,0,0,DPNREMOVEPLAYERFROMGROUP_SYNC));wait_value(&removed_local,1);record(removed_local);
 n=0;record(IDirectPlay8Peer_EnumGroupMembers(peer,new_group,0,&n,0));record(n);
 record(IDirectPlay8Peer_DestroyGroup(peer,new_group,0,0,DPNDESTROYGROUP_SYNC));wait_value(&groups_destroyed,1);record(groups_destroyed);record(group_destroy_context_ok);
 size=sizeof(storage);actual->dwSize=sizeof(*actual);record(IDirectPlay8Peer_GetGroupInfo(peer,new_group,actual,&size,0));
 n=0;record(IDirectPlay8Peer_EnumPlayersAndGroups(peer,0,&n,DPNENUM_GROUPS));record(n);n=4;record(IDirectPlay8Peer_EnumPlayersAndGroups(peer,ids,&n,DPNENUM_GROUPS));record(n==1&&ids[0]==auto_group);
}
#endif
static char *args(void){char *p=GetCommandLineA();if(*p=='"'){p++;while(*p&&*p!='"')p++;if(*p)p++;}else while(*p&&*p!=' ')p++;while(*p==' ')p++;return p;}
void entry(void){
 IDirectPlay8Peer *peer=0;IDirectPlay8Address *device=0,*host=0;DPN_APPLICATION_DESC desc;DWORD port=0,i,begin;HRESULT hr;char *arg=args();BOOL serving=*arg=='h',wildcard=*arg=='a',withdata=*arg=='d',joining=*arg=='j';
 while(*arg&&*arg!=' ')arg++;while(*arg==' ')arg++;while(*arg>='0'&&*arg<='9'){port=port*10+*arg-'0';arg++;}
#ifdef ORACLE_GUEST_PORT
 serving=FALSE;wildcard=FALSE;withdata=FALSE;port=ORACLE_GUEST_PORT;
#endif
#ifdef ORACLE_GUEST_JOIN
 joining=TRUE;
#endif
 host_mode=serving;
 if(!port||port>65535)ExitProcess(2);
 CoInitialize(0);hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr))goto finish;current_peer=peer;
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&device);record(hr);if(FAILED(hr))goto finish;
 record(IDirectPlay8Address_SetSP(device,&CLSID_DP8SP_TCPIP));
 for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication=application;desc.dwMaxPlayers=7;
 if(serving){
   WCHAR name[]={'W','i','r','e',0x416,0};desc.pwszSessionName=name;desc.pvApplicationReservedData=app_data;desc.dwApplicationReservedDataSize=3;
   record(IDirectPlay8Address_AddComponent(device,DPNA_KEY_PORT,&port,sizeof(port),DPNA_DATATYPE_DWORD));
   hr=IDirectPlay8Peer_Host(peer,&desc,&device,1,0,0,0,0);record(hr);
#ifdef ORACLE_GROUPS
   if(SUCCEEDED(hr)){DPN_GROUP_INFO info;WCHAR group_name[]={'A','u','t','o',0x416,0};for(i=0;i<sizeof(info);i++)((BYTE*)&info)[i]=0;info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME|DPNINFO_DATA;info.pwszName=group_name;info.pvData=app_data;info.dwDataSize=3;info.dwGroupFlags=DPNGROUP_AUTODESTRUCT;hr=IDirectPlay8Peer_CreateGroup(peer,&info,0,0,0,DPNCREATEGROUP_SYNC);if(SUCCEEDED(hr))hr=IDirectPlay8Peer_AddPlayerToGroup(peer,auto_group,local_id,0,0,DPNADDPLAYERTOGROUP_SYNC);}
#endif
   output("wire-host.ready",&hr,4);if(FAILED(hr))goto finish;
   begin=GetTickCount();while(GetTickCount()-begin<120000&&GetFileAttributesA("wire-host.stop")==INVALID_FILE_ATTRIBUTES)Sleep(5);
 }else{
   desc.dwMaxPlayers=0; if(wildcard)for(i=0;i<sizeof(GUID);i++)((BYTE*)&desc.guidApplication)[i]=0;
   hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&host);record(hr);if(FAILED(hr))goto finish;
   record(IDirectPlay8Address_SetSP(host,&CLSID_DP8SP_TCPIP));
#ifdef ORACLE_GUEST_PORT
   record(IDirectPlay8Address_AddComponent(host,DPNA_KEY_HOSTNAME,L"198.18.0.61",24,DPNA_DATATYPE_STRING));
#else
   record(IDirectPlay8Address_AddComponent(host,DPNA_KEY_HOSTNAME,L"127.0.0.1",20,DPNA_DATATYPE_STRING));
#endif
   record(IDirectPlay8Address_AddComponent(host,DPNA_KEY_PORT,&port,sizeof(port),DPNA_DATATYPE_DWORD));
   record(IDirectPlay8Peer_EnumHosts(peer,&desc,host,device,withdata?app_data:0,withdata?sizeof(app_data):0,1,100,300,0,0,DPNENUMHOSTS_SYNC));record(responses);
   if(joining){
     DPN_PLAYER_INFO info;BYTE storage[512];DPN_APPLICATION_DESC *actual=(DPN_APPLICATION_DESC*)storage;DPN_PLAYER_INFO *player=(DPN_PLAYER_INFO*)storage;DWORD size;void *player_context=0;DPN_BUFFER_DESC buffer;WCHAR name[]={'G','u','e','s','t',0x416,0};
     for(i=0;i<sizeof(info);i++)((BYTE*)&info)[i]=0;info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME|DPNINFO_DATA;info.pwszName=name;info.pvData=player_data;info.dwDataSize=sizeof(player_data);
     record(IDirectPlay8Peer_SetPeerInfo(peer,&info,0,0,DPNSETPEERINFO_SYNC));
     hr=IDirectPlay8Peer_Connect(peer,&desc,host,device,0,0,player_data,sizeof(player_data),(void*)0x1234,0,0,DPNCONNECT_SYNC);record(hr);if(FAILED(hr))goto finish;
     begin=GetTickCount();while(created<2&&GetTickCount()-begin<3000)Sleep(1);record(created);record(local_context_ok);
     size=0;record(IDirectPlay8Peer_GetApplicationDesc(peer,0,&size,0));record(size);
     size=sizeof(storage);actual->dwSize=sizeof(*actual);record(IDirectPlay8Peer_GetApplicationDesc(peer,actual,&size,0));record(actual->dwCurrentPlayers);record(actual->dwFlags);record(actual->pwszPassword==0);record(actual->pwszSessionName&&actual->pwszSessionName[4]==0x416);record(actual->dwApplicationReservedDataSize);
     size=0;record(IDirectPlay8Peer_GetPeerInfo(peer,local_id,0,&size,0));record(size);
     size=sizeof(storage);player->dwSize=sizeof(*player);record(IDirectPlay8Peer_GetPeerInfo(peer,local_id,player,&size,0));record(player->dwInfoFlags);record(player->dwPlayerFlags);record(player->pwszName&&player->pwszName[5]==0x416);record(player->dwDataSize);record(player->pvData&&hash_bytes(player->pvData,player->dwDataSize)==hash_bytes(player_data,sizeof(player_data)));
     record(IDirectPlay8Peer_GetPlayerContext(peer,local_id,&player_context,0));record(player_context==(void*)0x2345);
     for(i=0;i<sizeof(payload);i++)payload[i]=(BYTE)(i*17);buffer.pBufferData=payload;buffer.dwBufferSize=sizeof(payload);
     record(IDirectPlay8Peer_SendTo(peer,remote_id,&buffer,1,0,0,0,DPNSEND_SYNC|DPNSEND_GUARANTEED));
     begin=GetTickCount();while(!receive_count&&GetTickCount()-begin<5000)Sleep(1);record(receive_count);record(receive_size);record(receive_hash==hash_bytes(payload,sizeof(payload)));record(receive_flags);record(receive_pointer&&hash_bytes(receive_pointer,receive_size)==receive_hash);
     record(IDirectPlay8Peer_ReturnBuffer(peer,receive_handle,0));record(IDirectPlay8Peer_ReturnBuffer(peer,receive_handle,0));
     info.dwInfoFlags=DPNINFO_DATA;info.pwszName=0;info.pvData=updated_data;info.dwDataSize=sizeof(updated_data);record(IDirectPlay8Peer_SetPeerInfo(peer,&info,0,0,DPNSETPEERINFO_SYNC));
     size=sizeof(storage);player->dwSize=sizeof(*player);record(IDirectPlay8Peer_GetPeerInfo(peer,local_id,player,&size,0));record(player->pwszName&&player->pwszName[5]==0x416);record(player->dwDataSize);record(player->pvData&&hash_bytes(player->pvData,player->dwDataSize)==hash_bytes(updated_data,sizeof(updated_data)));
     size=0;record(IDirectPlay8Peer_GetPeerInfo(peer,remote_id,0,&size,0));record(size);size=sizeof(storage);player->dwSize=sizeof(*player);record(IDirectPlay8Peer_GetPeerInfo(peer,remote_id,player,&size,0));record(player->dwInfoFlags);record(player->dwPlayerFlags);record(player->pwszName==0);record(player->dwDataSize);record(player->pvData==0);
#ifdef ORACLE_GROUPS
     group_scenario(peer);
#endif
   }
 }
finish:
 if(peer){record(IDirectPlay8Peer_Close(peer,0));if(joining){record(destroyed);record(destroy_contexts);}IDirectPlay8Peer_Release(peer);}if(device)IDirectPlay8Address_Release(device);if(host)IDirectPlay8Address_Release(host);
 observations[0]=0x42534c4e;observations[1]=count;observations[2]=ORACLE_NONCE;
#ifdef ORACLE_GUEST_PORT
 output("C:\\lan-oracle.bin",observations,count*4);
#else
 output(serving?"wire-host.bin":joining?"wire-connect.bin":"wire-client.bin",observations,count*4);
#endif
 CoUninitialize();ExitProcess(FAILED(hr)?1:0);
}
