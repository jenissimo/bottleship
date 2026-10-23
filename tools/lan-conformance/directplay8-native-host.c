/* Stage28 native-only Host+one Peer diagnostic. Unbuilt draft.
 * Two roles of the same 32-bit PE; --reject selects application admission failure.
 * This fixture hooks only its own loaded dpnet.dll WSASendTo IAT slot. It records
 * full small datagrams without rewriting the DLL on disk, packet bytes, arguments,
 * return value or Winsock error. No RAW sockets or external destinations.
 * Reference navigation is documented in runner-design.md; source is not proof.
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_HOST_PORT
#define ORACLE_HOST_PORT 45100
#endif
#define OBS_LIMIT 1024
#define EVENT_LIMIT 128
#define EVENT_WORDS 20
#define ADDRESS_LIMIT 16
#define URL_CHARS 512
#define TRACE_LIMIT 512
#define TRACE_BYTES 4096
#define TRACE_WORDS 27
#define HOST_CONTEXT ((void*)0x7100)
#define PEER_CONTEXT ((void*)0x7101)
#define ADMISSION_CONTEXT ((void*)0x7201)
#define REPLY_CONTEXT ((void*)0x7301)
#define CONNECT_CONTEXT ((void*)0x7401)

typedef struct EventRow { DWORD words[EVENT_WORDS]; } EventRow;
typedef struct AddressRow { DWORD words[10]; WCHAR url[URL_CHARS]; } AddressRow;
typedef struct PacketRow { DWORD words[TRACE_WORDS]; BYTE bytes[TRACE_BYTES]; } PacketRow;
typedef int (WSAAPI *SendToFunction)(SOCKET,LPWSABUF,DWORD,LPDWORD,DWORD,const struct sockaddr*,int,LPWSAOVERLAPPED,LPWSAOVERLAPPED_COMPLETION_ROUTINE);

static IDirectPlay8Peer *peer;
static CRITICAL_SECTION state_lock,wire_lock,address_lock;
static DWORD observations[OBS_LIMIT],observation_count=3,role,reject_mode,phase,failure;
static EventRow events[EVENT_LIMIT];
static AddressRow addresses[ADDRESS_LIMIT];
static PacketRow packets[TRACE_LIMIT];
static volatile DWORD event_count,event_dropped,address_count,address_dropped,wire_count,wire_dropped;
static volatile DWORD ids[2],creates[2],destroys[2],known_mask,received,invalid_data,late_callbacks;
static volatile DWORD indications,returns,aborted,connect_completions,connect_result,reply_size,reply_ok,connect_context_ok;
static volatile DWORD return_pointer_ok,return_context_ok,return_original_ok;
static volatile DWORD create_context_ok[2],destroy_context_ok[2],destroy_reason[2];
static volatile DWORD indicated_initial_zero,indicated_connect_ok,indicated_app_count,indicated_app_result;
static BYTE reply_source[8],reply_copy[64];
static BYTE *retained_receive;
static DPNHANDLE retained_handle,connect_handle;
static HANDLE watchdog_stop,watchdog_thread;
static DWORD hook_installed,*patched_slot,original_slot;
static SendToFunction original_send;
static const WCHAR *names[2]={L"stage28-host",L"stage28-peer"};

static void clear_bytes(void *pointer,DWORD size){DWORD i;for(i=0;i<size;i++)((BYTE*)pointer)[i]=0;}
static void copy_bytes(void *target,const void *source,DWORD size){DWORD i;for(i=0;i<size;i++)((BYTE*)target)[i]=((const BYTE*)source)[i];}
static DWORD word_at(const BYTE *bytes,DWORD size,DWORD offset){DWORD i,value=0;if(!bytes)return 0;for(i=0;i<4&&offset+i<size;i++)value|=(DWORD)bytes[offset+i]<<(i*8);return value;}
static int equal_w(const WCHAR *a,const WCHAR *b){if(!a||!b)return 0;while(*a&&*a==*b){a++;b++;}return *a==*b;}
static int contains(const char *text,const char *part){const char *a,*b;while(*text){a=text;b=part;while(*a&&*b&&*a==*b){a++;b++;}if(!*b)return 1;text++;}return 0;}
static int bytes_equal(const BYTE *a,const BYTE *b,DWORD size){DWORD i;if(!a||!b)return 0;for(i=0;i<size;i++)if(a[i]!=b[i])return 0;return 1;}
static void write_file(const char *path,const void *bytes,DWORD size){
 HANDLE file;DWORD written=0;file=CreateFileA(path,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(file!=INVALID_HANDLE_VALUE){WriteFile(file,bytes,size,&written,0);FlushFileBuffers(file);CloseHandle(file);}
}
static void record(DWORD tag,DWORD value){
 if(observation_count+2<=OBS_LIMIT){observations[observation_count++]=tag;observations[observation_count++]=value;}
 observations[0]=0x42534c4e;observations[1]=observation_count;observations[2]=ORACLE_NONCE;
 write_file("host-progress.bin",observations,observation_count*4);
}
static void marker(const char *name){DWORD value=ORACLE_NONCE;write_file(name,&value,4);}
static int marked(const char *name){
 HANDLE file;DWORD value=0,size=0;file=CreateFileA(name,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);
 if(file==INVALID_HANDLE_VALUE)return 0;ReadFile(file,&value,4,&size,0);CloseHandle(file);return size==4&&value==ORACLE_NONCE;
}
static int wait_marker(const char *name,DWORD timeout){DWORD start=GetTickCount();while(!marked(name)){if(GetTickCount()-start>=timeout)return 0;Sleep(2);}return 1;}
static int wait_value(volatile DWORD *value,DWORD minimum,DWORD timeout){DWORD start=GetTickCount();while(*value<minimum){if(GetTickCount()-start>=timeout)return 0;Sleep(1);}return 1;}
static void flush_events_locked(void){
 DWORD header[9];HANDLE file;DWORD written;
 header[0]=0x42534845;header[1]=1;header[2]=ORACLE_NONCE;header[3]=role;header[4]=reject_mode;
 header[5]=event_count;header[6]=event_dropped;header[7]=EVENT_WORDS;header[8]=phase;
 file=CreateFileA("callback-events.bin",GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(file!=INVALID_HANDLE_VALUE){WriteFile(file,header,sizeof(header),&written,0);WriteFile(file,events,event_count*sizeof(events[0]),&written,0);FlushFileBuffers(file);CloseHandle(file);}
}
static void event(DWORD message,DWORD size,DWORD id,DWORD context,DWORD result,DWORD bytes,DWORD flags,DWORD extra,DWORD pointer,DWORD handle,DWORD first,DWORD second){
 EventRow *row;EnterCriticalSection(&state_lock);
 if(event_count>=EVENT_LIMIT){event_dropped++;LeaveCriticalSection(&state_lock);return;}
 row=&events[event_count];row->words[0]=event_count;row->words[1]=GetTickCount();row->words[2]=GetCurrentThreadId();
 row->words[3]=message;row->words[4]=phase;row->words[5]=size;row->words[6]=id;row->words[7]=context;
 row->words[8]=result;row->words[9]=bytes;row->words[10]=flags;row->words[11]=extra;
 row->words[12]=0;row->words[13]=0;row->words[14]=pointer;row->words[15]=handle;
 row->words[16]=first;row->words[17]=second;row->words[18]=role;row->words[19]=reject_mode;
 event_count++;flush_events_locked();LeaveCriticalSection(&state_lock);
}
static void capture_address(IDirectPlay8Address *address,DWORD kind,DWORD subject){
 AddressRow row;DWORD size=4,type=0,port=0,chars=URL_CHARS;HRESULT port_hr=E_POINTER,url_hr=E_POINTER;
 clear_bytes(&row,sizeof(row));
 if(address){port_hr=IDirectPlay8Address_GetComponentByName(address,DPNA_KEY_PORT,&port,&size,&type);url_hr=IDirectPlay8Address_GetURLW(address,row.url,&chars);}
 row.words[0]=kind;row.words[1]=subject;row.words[2]=(DWORD)port_hr;row.words[3]=port;row.words[4]=type;
 row.words[5]=(DWORD)url_hr;row.words[6]=chars;row.words[7]=GetTickCount();row.words[8]=GetCurrentThreadId();row.words[9]=address!=0;
 EnterCriticalSection(&address_lock);if(address_count<ADDRESS_LIMIT){copy_bytes(&addresses[address_count],&row,sizeof(row));address_count++;}else address_dropped++;LeaveCriticalSection(&address_lock);
}
static void flush_addresses(void){
 DWORD header[8],written;HANDLE file;EnterCriticalSection(&address_lock);
 header[0]=0x42534841;header[1]=1;header[2]=ORACLE_NONCE;header[3]=role;header[4]=reject_mode;
 header[5]=address_count;header[6]=address_dropped;header[7]=sizeof(AddressRow);
 file=CreateFileA("native-addresses.bin",GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(file!=INVALID_HANDLE_VALUE){WriteFile(file,header,sizeof(header),&written,0);WriteFile(file,addresses,address_count*sizeof(addresses[0]),&written,0);FlushFileBuffers(file);CloseHandle(file);}
 LeaveCriticalSection(&address_lock);
}
static int WSAAPI traced_send(SOCKET socket,LPWSABUF buffers,DWORD count,LPDWORD sent,DWORD flags,const struct sockaddr *to,int to_size,LPWSAOVERLAPPED overlapped,LPWSAOVERLAPPED_COMPLETION_ROUTINE completion){
 DWORD index,i,j,copied=0,bytes=0;int saved=WSAGetLastError(),size,result,error;SOCKADDR_STORAGE local;
 size=sizeof(local);clear_bytes(&local,sizeof(local));getsockname(socket,(struct sockaddr*)&local,&size);WSASetLastError(saved);
 EnterCriticalSection(&wire_lock);index=wire_count;
 if(index<TRACE_LIMIT){
  PacketRow *row=&packets[index];wire_count++;
  for(i=0;i<count;i++){bytes+=buffers[i].len;for(j=0;j<buffers[i].len&&copied<TRACE_BYTES;j++)row->bytes[copied++]=(BYTE)buffers[i].buf[j];}
  row->words[0]=GetTickCount();row->words[1]=GetCurrentThreadId();row->words[2]=(DWORD)socket;
  row->words[3]=local.ss_family==AF_INET?((struct sockaddr_in*)&local)->sin_addr.s_addr:0;
  row->words[4]=local.ss_family==AF_INET?ntohs(((struct sockaddr_in*)&local)->sin_port):0;
  row->words[5]=to&&to_size>=(int)sizeof(struct sockaddr_in)&&to->sa_family==AF_INET?((const struct sockaddr_in*)to)->sin_addr.s_addr:0;
  row->words[6]=to&&to_size>=(int)sizeof(struct sockaddr_in)?ntohs(((const struct sockaddr_in*)to)->sin_port):0;
  row->words[7]=bytes;row->words[8]=copied;row->words[9]=flags;row->words[10]=overlapped!=0;
  row->words[13]=local.ss_family;row->words[14]=to?to->sa_family:0;row->words[15]=(DWORD)size;row->words[16]=(DWORD)to_size;
  if(local.ss_family==AF_INET6){copy_bytes(&row->words[17],&((struct sockaddr_in6*)&local)->sin6_addr,16);row->words[25]=((struct sockaddr_in6*)&local)->sin6_scope_id;}
  if(to&&to_size>=(int)sizeof(struct sockaddr_in6)&&to->sa_family==AF_INET6){copy_bytes(&row->words[21],&((const struct sockaddr_in6*)to)->sin6_addr,16);row->words[26]=((const struct sockaddr_in6*)to)->sin6_scope_id;}
 }else wire_dropped++;
 LeaveCriticalSection(&wire_lock);
 WSASetLastError(saved);result=original_send(socket,buffers,count,sent,flags,to,to_size,overlapped,completion);error=WSAGetLastError();
 EnterCriticalSection(&wire_lock);if(index<TRACE_LIMIT){packets[index].words[11]=(DWORD)result;packets[index].words[12]=(DWORD)error;}LeaveCriticalSection(&wire_lock);
 WSASetLastError(error);return result;
}
static void install_hook(void){
 BYTE *base=(BYTE*)GetModuleHandleA("dpnet.dll");IMAGE_DOS_HEADER *dos;IMAGE_NT_HEADERS32 *nt;IMAGE_IMPORT_DESCRIPTOR *descriptor;DWORD protection,*slot;
 union { FARPROC raw; SendToFunction typed; } function;
 function.raw=GetProcAddress(GetModuleHandleA("ws2_32.dll"),"WSASendTo");original_send=function.typed;if(!base||!original_send)return;
 dos=(IMAGE_DOS_HEADER*)base;if(dos->e_magic!=IMAGE_DOS_SIGNATURE)return;
 nt=(IMAGE_NT_HEADERS32*)(base+dos->e_lfanew);if(nt->Signature!=IMAGE_NT_SIGNATURE||nt->OptionalHeader.Magic!=IMAGE_NT_OPTIONAL_HDR32_MAGIC)return;
 descriptor=(IMAGE_IMPORT_DESCRIPTOR*)(base+nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
 for(;descriptor->Name;descriptor++)for(slot=(DWORD*)(base+descriptor->FirstThunk);*slot;slot++){
  if(*slot!=(DWORD)original_send)continue;if(!VirtualProtect(slot,4,PAGE_READWRITE,&protection))return;
  original_slot=*slot;patched_slot=slot;InterlockedExchange((LONG*)slot,(LONG)traced_send);VirtualProtect(slot,4,protection,&protection);hook_installed=1;return;
 }
}
static void remove_hook(void){DWORD protection;if(patched_slot&&VirtualProtect(patched_slot,4,PAGE_READWRITE,&protection)){InterlockedExchange((LONG*)patched_slot,(LONG)original_slot);VirtualProtect(patched_slot,4,protection,&protection);patched_slot=0;}}
static void flush_wire_locked(void){
 DWORD header[9],written;HANDLE file;header[0]=0x42534d54;header[1]=3;header[2]=ORACLE_NONCE;header[3]=role;
 header[4]=hook_installed;header[5]=wire_count;header[6]=wire_dropped;header[7]=TRACE_WORDS;header[8]=TRACE_BYTES;
 file=CreateFileA("native-wire.bin",GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(file!=INVALID_HANDLE_VALUE){WriteFile(file,header,sizeof(header),&written,0);WriteFile(file,packets,wire_count*sizeof(packets[0]),&written,0);FlushFileBuffers(file);CloseHandle(file);}
}
static void flush_wire(void){EnterCriticalSection(&wire_lock);flush_wire_locked();LeaveCriticalSection(&wire_lock);}
static DWORD WINAPI watchdog(void *unused){
 DWORD report[6];(void)unused;
 if(WaitForSingleObject(watchdog_stop,35000)==WAIT_OBJECT_0)return 0;
 report[0]=0x42534857;report[1]=ORACLE_NONCE;report[2]=role;report[3]=reject_mode;report[4]=phase;report[5]=failure;
 write_file("watchdog.bin",report,sizeof(report));
 if(TryEnterCriticalSection(&state_lock)){flush_events_locked();LeaveCriticalSection(&state_lock);}
 if(TryEnterCriticalSection(&wire_lock)){flush_wire_locked();LeaveCriticalSection(&wire_lock);}
 ExitProcess(98);return 0;
}
static int id_role(DPNID id){if(ids[0]&&ids[0]==id)return 0;if(ids[1]&&ids[1]==id)return 1;return -1;}
static void expected_reply(BYTE *bytes){bytes[0]=0x52;bytes[1]=(BYTE)reject_mode;bytes[2]=(BYTE)ORACLE_NONCE;bytes[3]=(BYTE)(ORACLE_NONCE>>8);bytes[4]=0x61;bytes[5]=0x62;bytes[6]=0x63;bytes[7]=0;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
 DWORD i,size,flags=0,extra=0;int source=-1;BYTE storage[256],expected[8];HRESULT hr;DPN_PLAYER_INFO *info=(DPN_PLAYER_INFO*)storage;(void)context;
 if(phase==3)InterlockedIncrement((LONG*)&late_callbacks);
 if(message==DPN_MSGID_INDICATE_CONNECT){
  DPNMSG_INDICATE_CONNECT *m=data;DWORD payload_ok;
  BYTE connect_bytes[8]={0x43,0x31,0,0,0x28,0x48,0x4f,0x53};connect_bytes[2]=(BYTE)ORACLE_NONCE;connect_bytes[3]=(BYTE)(ORACLE_NONCE>>8);
  payload_ok=m->dwUserConnectDataSize==8&&bytes_equal(m->pvUserConnectData,connect_bytes,8);
  indicated_initial_zero=!m->pvReplyData&&!m->dwReplyDataSize&&!m->pvReplyContext&&!m->pvPlayerContext;
  indicated_connect_ok=payload_ok;
  capture_address(m->pAddressPlayer,2,1);capture_address(m->pAddressDevice,3,0);
  clear_bytes(storage,sizeof(storage));((DPN_APPLICATION_DESC*)storage)->dwSize=sizeof(DPN_APPLICATION_DESC);size=sizeof(storage);
  hr=IDirectPlay8Peer_GetApplicationDesc(peer,(DPN_APPLICATION_DESC*)storage,&size,0);
  indicated_app_result=(DWORD)hr;indicated_app_count=SUCCEEDED(hr)?((DPN_APPLICATION_DESC*)storage)->dwCurrentPlayers:0xffffffff;
  expected_reply(reply_source);m->pvReplyData=reply_source;m->dwReplyDataSize=8;m->pvReplyContext=REPLY_CONTEXT;m->pvPlayerContext=ADMISSION_CONTEXT;
  event(message,m->dwSize,0,(DWORD)m->pvPlayerContext,(DWORD)(reject_mode?E_FAIL:S_OK),m->dwUserConnectDataSize,indicated_initial_zero,indicated_app_count,(DWORD)m->pvReplyData,0,word_at(m->pvUserConnectData,m->dwUserConnectDataSize,0),word_at(m->pvUserConnectData,m->dwUserConnectDataSize,4));
  if(role||!payload_ok)InterlockedIncrement((LONG*)&invalid_data);
  InterlockedIncrement((LONG*)&indications);return reject_mode?E_FAIL:S_OK;
 }
 if(message==DPN_MSGID_RETURN_BUFFER){
  DPNMSG_RETURN_BUFFER *m=data;expected_reply(expected);
  return_pointer_ok=m->pvBuffer==reply_source;return_context_ok=m->pvUserContext==REPLY_CONTEXT;return_original_ok=return_pointer_ok&&bytes_equal(m->pvBuffer,expected,8);
  event(message,m->dwSize,0,(DWORD)m->pvUserContext,(DWORD)m->hResultCode,8,return_pointer_ok|(return_context_ok<<1)|(return_original_ok<<2),0,(DWORD)m->pvBuffer,0,return_pointer_ok?word_at(m->pvBuffer,8,0):0,return_pointer_ok?word_at(m->pvBuffer,8,4):0);
  /* RETURN_BUFFER transfers ownership back to this application. Reuse it now;
     the remote reply must already have been copied by the provider. */
  if(m->pvBuffer==reply_source)for(i=0;i<8;i++)reply_source[i]=(BYTE)(0xe0+i);
  InterlockedIncrement((LONG*)&returns);return S_OK;
 }
 if(message==DPN_MSGID_CONNECT_COMPLETE){
  DPNMSG_CONNECT_COMPLETE *m=data;DWORD copied=m->dwApplicationReplyDataSize;
  if(copied>sizeof(reply_copy))copied=sizeof(reply_copy);
  if(copied&&m->pvApplicationReplyData)copy_bytes(reply_copy,m->pvApplicationReplyData,copied);
  expected_reply(expected);reply_size=m->dwApplicationReplyDataSize;reply_ok=reply_size==8&&bytes_equal(reply_copy,expected,8);
  connect_context_ok=m->pvUserContext==CONNECT_CONTEXT;connect_result=(DWORD)m->hResultCode;
  event(message,m->dwSize,0,(DWORD)m->pvUserContext,connect_result,reply_size,connect_context_ok,reply_ok,(DWORD)m->pvApplicationReplyData,m->hAsyncOp,word_at(reply_copy,copied,0),word_at(reply_copy,copied,4));
  InterlockedIncrement((LONG*)&connect_completions);return S_OK;
 }
 if(message==DPN_MSGID_CREATE_PLAYER){
  DPNMSG_CREATE_PLAYER *m=data;DWORD incoming_context=(DWORD)m->pvPlayerContext;clear_bytes(storage,sizeof(storage));info->dwSize=sizeof(*info);size=sizeof(storage);
  hr=IDirectPlay8Peer_GetPeerInfo(peer,m->dpnidPlayer,info,&size,0);
  if(SUCCEEDED(hr))for(i=0;i<2;i++)if(equal_w(info->pwszName,names[i]))source=(int)i;
  if(source>=0){
   void *expected_context=role==0&&source==1?ADMISSION_CONTEXT:source==(int)role?(role?PEER_CONTEXT:HOST_CONTEXT):0;
   ids[source]=m->dpnidPlayer;create_context_ok[source]=m->pvPlayerContext==expected_context;creates[source]++;
   flags=info->dwPlayerFlags;extra=create_context_ok[source];m->pvPlayerContext=(void*)(0x7500+source);
   InterlockedOr((LONG*)&known_mask,1L<<source);
  }else InterlockedIncrement((LONG*)&invalid_data);
  event(message,m->dwSize,m->dpnidPlayer,incoming_context,(DWORD)hr,0,flags,extra,0,0,0,0);return S_OK;
 }
 if(message==DPN_MSGID_INDICATED_CONNECT_ABORTED){
  DPNMSG_INDICATED_CONNECT_ABORTED *m=data;event(message,m->dwSize,0,(DWORD)m->pvPlayerContext,0,0,0,0,0,0,0,0);
  InterlockedIncrement((LONG*)&aborted);return S_OK;
 }
 if(message==DPN_MSGID_RECEIVE){
  DPNMSG_RECEIVE *m=data;BYTE payload[4];source=id_role(m->dpnidSender);
  payload[0]=0x48;payload[1]=(BYTE)(1-role);payload[2]=0x28;payload[3]=0x7a;
  if(source!=(int)(1-role)||m->dwReceiveDataSize!=4||!bytes_equal(m->pReceiveData,payload,4)||retained_receive)InterlockedIncrement((LONG*)&invalid_data);
  else{retained_receive=m->pReceiveData;retained_handle=m->hBufferHandle;}
  event(message,m->dwSize,m->dpnidSender,(DWORD)m->pvPlayerContext,0,m->dwReceiveDataSize,m->dwReceiveFlags,0,(DWORD)m->pReceiveData,m->hBufferHandle,word_at(m->pReceiveData,m->dwReceiveDataSize,0),0);
  InterlockedIncrement((LONG*)&received);return retained_receive==m->pReceiveData?DPNSUCCESS_PENDING:S_OK;
 }
 if(message==DPN_MSGID_DESTROY_PLAYER){
  DPNMSG_DESTROY_PLAYER *m=data;source=id_role(m->dpnidPlayer);
  if(source>=0){destroys[source]++;destroy_context_ok[source]=m->pvPlayerContext==(void*)(0x7500+source);destroy_reason[source]=m->dwReason;}
  else InterlockedIncrement((LONG*)&invalid_data);
  event(message,m->dwSize,m->dpnidPlayer,(DWORD)m->pvPlayerContext,0,0,m->dwReason,source>=0?destroy_context_ok[source]:0,0,0,0,0);return S_OK;
 }
 event(message,data?((DWORD*)data)[0]:0,0,0,0,0,0,0,0,0,0,0);return S_OK;
}
static HRESULT make_address(IDirectPlay8Address **out,const WCHAR *host,DWORD port){
 DWORD chars=0,traversal=0;HRESULT hr;const GUID loopback={0x4ce725f6,0x7b7f,0x4297,{0xba,0x6f,0x11,0xf9,0x65,0xbc,0x42,0x99}};
 hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)out);if(FAILED(hr))return hr;
 hr=IDirectPlay8Address_SetSP(*out,&CLSID_DP8SP_TCPIP);if(FAILED(hr))return hr;
 if(host){while(host[chars])chars++;hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_HOSTNAME,host,(chars+1)*2,DPNA_DATATYPE_STRING);}
 else hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_DEVICE,&loopback,sizeof(loopback),DPNA_DATATYPE_GUID);
 if(FAILED(hr))return hr;hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_TRAVERSALMODE,&traversal,4,DPNA_DATATYPE_DWORD);if(FAILED(hr))return hr;
 return IDirectPlay8Address_AddComponent(*out,DPNA_KEY_PORT,&port,4,DPNA_DATATYPE_DWORD);
}
static void local_addresses(void){
 IDirectPlay8Address *items[8];DWORD count=8,i;HRESULT hr;
 for(i=0;i<8;i++)items[i]=0;
 hr=IDirectPlay8Peer_GetLocalHostAddresses(peer,items,&count,0);record(20,(DWORD)hr);record(21,count);
 if(SUCCEEDED(hr))for(i=0;i<count&&i<8;i++)if(items[i]){capture_address(items[i],1,i);IDirectPlay8Address_Release(items[i]);}
}
static void app_count(DWORD tag){
 BYTE storage[256];DWORD size=sizeof(storage);HRESULT hr;clear_bytes(storage,sizeof(storage));((DPN_APPLICATION_DESC*)storage)->dwSize=sizeof(DPN_APPLICATION_DESC);
 hr=IDirectPlay8Peer_GetApplicationDesc(peer,(DPN_APPLICATION_DESC*)storage,&size,0);record(tag,(DWORD)hr);record(tag+1,SUCCEEDED(hr)?((DPN_APPLICATION_DESC*)storage)->dwCurrentPlayers:0xffffffff);
}
static void snapshot(DWORD base){
 DWORD i;record(base,known_mask);record(base+1,indications);record(base+2,returns);record(base+3,aborted);
 record(base+4,connect_completions);record(base+5,connect_result);record(base+6,reply_size);record(base+7,reply_ok);record(base+8,connect_context_ok);
 record(base+9,return_pointer_ok);record(base+10,return_context_ok);record(base+11,return_original_ok);
 record(base+12,indicated_initial_zero);record(base+13,indicated_connect_ok);record(base+14,indicated_app_count);
 record(base+15,received);record(base+16,invalid_data);record(base+17,indicated_app_result);
 for(i=0;i<2;i++){record(base+20+i,creates[i]);record(base+22+i,destroys[i]);record(base+24+i,create_context_ok[i]);record(base+26+i,destroy_context_ok[i]);record(base+28+i,destroy_reason[i]);}
}
void entry(void){
 IDirectPlay8Address *device=0,*host=0,*remote=0;DPN_APPLICATION_DESC desc;DPN_PLAYER_INFO info;DPN_CAPS caps;DPN_BUFFER_DESC buffer;
 DWORD i,context;HRESULT hr;BYTE connect_bytes[8]={0x43,0x31,0,0,0x28,0x48,0x4f,0x53},payload[4];HANDLE wait_thread;
 const char *command=GetCommandLineA();role=contains(command,"--peer")?1:0;reject_mode=contains(command,"--reject")?1:0;
 SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
 InitializeCriticalSection(&state_lock);InitializeCriticalSection(&wire_lock);InitializeCriticalSection(&address_lock);
 watchdog_stop=CreateEventA(0,TRUE,FALSE,0);if(watchdog_stop)watchdog_thread=CreateThread(0,0,watchdog,0,0,0);
 if(!watchdog_stop||!watchdog_thread){failure=1;goto done;}
 record(1,role);record(2,reject_mode);record(3,(DWORD)CoInitialize(0));
 hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(4,(DWORD)hr);if(FAILED(hr)){failure=2;goto done;}
 hr=IDirectPlay8Peer_Initialize(peer,0,callback,0);record(5,(DWORD)hr);if(FAILED(hr)){failure=3;goto done;}install_hook();record(6,hook_installed);if(!hook_installed){failure=4;goto done;}
 clear_bytes(&caps,sizeof(caps));caps.dwSize=sizeof(caps);caps.dwConnectTimeout=150;caps.dwConnectRetries=10;caps.dwTimeoutUntilKeepAlive=10000;
 hr=IDirectPlay8Peer_SetCaps(peer,&caps,0);record(7,(DWORD)hr);if(FAILED(hr)){failure=5;goto done;}
 clear_bytes(&info,sizeof(info));info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME;info.pwszName=(WCHAR*)names[role];
 hr=IDirectPlay8Peer_SetPeerInfo(peer,&info,0,0,DPNSETPEERINFO_SYNC);record(8,(DWORD)hr);if(FAILED(hr)){failure=6;goto done;}
 hr=make_address(&device,0,ORACLE_HOST_PORT+role);record(9,(DWORD)hr);if(FAILED(hr)){failure=7;goto done;}
 clear_bytes(&desc,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;desc.guidApplication.Data2=0x28a1;desc.dwMaxPlayers=2;
 phase=1;
 if(role==0){
  desc.pwszSessionName=L"Stage28 native Host";hr=IDirectPlay8Peer_Host(peer,&desc,&device,1,0,0,HOST_CONTEXT,0);
  record(10,(DWORD)hr);if(FAILED(hr)){failure=8;goto done;}
  if(!wait_value(&known_mask,1,5000)){failure=9;goto done;}
  local_addresses();flush_addresses();marker("host-ready.bin");
  if(!wait_value(&indications,1,10000)||!wait_value(&returns,1,8000)){failure=10;goto done;}
  if(!reject_mode&&!wait_value(&known_mask,3,8000)){failure=11;goto done;}
  app_count(30);snapshot(100);flush_addresses();marker("host-admission-done.bin");
 }else{
  hr=make_address(&host,L"127.0.0.1",ORACLE_HOST_PORT);record(11,(DWORD)hr);if(FAILED(hr)){failure=12;goto done;}
  connect_bytes[2]=(BYTE)ORACLE_NONCE;connect_bytes[3]=(BYTE)(ORACLE_NONCE>>8);
  hr=IDirectPlay8Peer_Connect(peer,&desc,host,device,0,0,connect_bytes,8,PEER_CONTEXT,CONNECT_CONTEXT,&connect_handle,0);
  record(12,(DWORD)hr);record(13,connect_handle!=0);
  if(FAILED(hr)){failure=13;goto done;}
  if(!wait_value(&connect_completions,1,8000)){failure=14;goto done;}
  record(14,connect_result);record(15,reply_size);record(16,reply_ok);record(17,connect_context_ok);
  if((reject_mode&&!FAILED((HRESULT)connect_result))||(!reject_mode&&FAILED((HRESULT)connect_result))){failure=15;goto done;}
  if(!reject_mode&&!wait_value(&known_mask,3,8000)){failure=16;goto done;}
  snapshot(100);marker("peer-admission-done.bin");
 }
 if(!reject_mode){
  for(i=0;i<2;i++){context=0;hr=IDirectPlay8Peer_GetPlayerContext(peer,ids[i],(void**)&context,0);record(200+i*2,(DWORD)hr);record(201+i*2,context==0x7500+i);}
  hr=IDirectPlay8Peer_GetPeerAddress(peer,ids[1-role],&remote,0);record(210,(DWORD)hr);if(SUCCEEDED(hr)&&remote){capture_address(remote,4,1-role);IDirectPlay8Address_Release(remote);remote=0;}
  flush_addresses();marker("exchange-ready.bin");if(!wait_marker("send-go.bin",10000)){failure=17;goto done;}
  payload[0]=0x48;payload[1]=(BYTE)role;payload[2]=0x28;payload[3]=0x7a;buffer.dwBufferSize=4;buffer.pBufferData=payload;
  hr=IDirectPlay8Peer_SendTo(peer,ids[1-role],&buffer,1,3000,0,0,DPNSEND_GUARANTEED|DPNSEND_SYNC);record(220,(DWORD)hr);
  if(FAILED(hr)||!wait_value(&received,1,8000)){failure=18;goto done;}
  record(221,retained_receive!=0);record(222,retained_receive?word_at(retained_receive,4,0):0);
  hr=IDirectPlay8Peer_ReturnBuffer(peer,retained_handle,0);record(223,(DWORD)hr);retained_receive=0;record(224,(DWORD)IDirectPlay8Peer_ReturnBuffer(peer,retained_handle,0));retained_handle=0;
  app_count(230);marker("exchange-done.bin");
 }
 if(role==1){
  if(!wait_marker("peer-close-go.bin",10000)){failure=19;goto done;}
 }else{
  if(!reject_mode){
   if(!wait_value(&destroys[1],1,10000)){failure=20;goto done;}
   app_count(240);context=0;record(242,(DWORD)IDirectPlay8Peer_GetPlayerContext(peer,ids[1],(void**)&context,0));marker("host-peer-closed.bin");
  }
  if(!wait_marker("host-close-go.bin",10000)){failure=21;goto done;}
 }
done:
 phase=2;
 if(peer){
  record(250,(DWORD)IDirectPlay8Peer_Close(peer,0));phase=3;
  remove_hook();IDirectPlay8Peer_Release(peer);peer=0;
 }
 if(remote)IDirectPlay8Address_Release(remote);if(host)IDirectPlay8Address_Release(host);if(device)IDirectPlay8Address_Release(device);
 snapshot(300);record(340,late_callbacks);record(341,event_dropped);record(342,address_dropped);record(343,wire_dropped);
 flush_wire();flush_addresses();EnterCriticalSection(&state_lock);flush_events_locked();LeaveCriticalSection(&state_lock);
 record(399,failure);write_file("lan-oracle.bin",observations,observation_count*4);
 if(watchdog_stop)SetEvent(watchdog_stop);wait_thread=watchdog_thread;
 if(wait_thread){WaitForSingleObject(wait_thread,1000);CloseHandle(wait_thread);}
 if(watchdog_stop)CloseHandle(watchdog_stop);
 CoUninitialize();DeleteCriticalSection(&address_lock);DeleteCriticalSection(&wire_lock);DeleteCriticalSection(&state_lock);
 marker("done.bin");ExitProcess(failure?1:0);
}
