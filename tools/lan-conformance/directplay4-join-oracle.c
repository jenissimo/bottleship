#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
/* Isolated two-process x86 API observation. No capture or service manipulation. */
static GUID app={0,0x7319,0x4ae1,{0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1}};
static GUID found;static int matches,oracleAnsi,oracleCyr;
static DWORD WINAPI watchdog(void *unused){(void)unused;Sleep(25000);ExitProcess(124);return 0;}
static BOOL CALLBACK enum_session(LPCDPSESSIONDESC2 desc,LPDWORD timeout,DWORD flags,LPVOID context){
 (void)timeout;(void)context;
 if(flags&DPESC_TIMEDOUT)return FALSE;
 if(desc&&IsEqualGUID(&desc->guidApplication,&app)){found=desc->guidInstance;matches++;return FALSE;}
 return TRUE;
}
static int ready_write(const char *path,DWORD nonce,DPID id){
 DWORD record[4]={0x4a345044,nonce,GetCurrentProcessId(),id},n;HANDLE f=CreateFileA(path,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
 if(f==INVALID_HANDLE_VALUE)return 0;int ok=WriteFile(f,record,sizeof(record),&n,NULL)&&n==sizeof(record);CloseHandle(f);return ok;
}
static int read_ready(const char *path,DWORD nonce,DPID *id){
 DWORD record[4],n;HANDLE f=CreateFileA(path,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,0,NULL);
 if(f==INVALID_HANDLE_VALUE)return 0;int ok=ReadFile(f,record,sizeof(record),&n,NULL)&&n==sizeof(record)&&record[0]==0x4a345044&&record[1]==nonce&&record[3];
 CloseHandle(f);if(ok)*id=record[3];return ok;
}
static int flags_check(IDirectPlay4 *play,DPID own,DPID remote){
 DWORD ownflags=0,remoteflags=0;HRESULT a=IDirectPlayX_GetPlayerFlags(play,own,&ownflags),b=IDirectPlayX_GetPlayerFlags(play,remote,&remoteflags);
 printf("FLAGS own=%08lx remote=%08lx hr=%08lx,%08lx\n",(unsigned long)ownflags,(unsigned long)remoteflags,(unsigned long)(DWORD)a,(unsigned long)(DWORD)b);
 return SUCCEEDED(a)&&SUCCEEDED(b);
}
static void message_details(BYTE *buffer,DWORD size,DWORD type){
 DWORD ptr=0,flags=0,count=0,offset=0,dataPtr=0,dataSize=0,dataOffset=0,nameSize=0,longPtr=0,longOffset=0,parent=0;int nameok=0,longok=0,dataok=0;static const WCHAR expectedW[]=L"Client",expectedLongW[]=L"Client Long";static const char expectedA[]="Client",expectedLongA[]="Client Long";static const BYTE expectedData[]={0x12,0x34,0x56,0x78};
 static const char cyrA[]="\xc8\xe3\xf0\xee\xea",cyrLongA[]="\xc8\xe3\xf0\xee\xea \xd2\xe5\xf1\xf2";
 const void *expected=oracleCyr?(const void*)cyrA:(oracleAnsi?(const void*)expectedA:(const void*)expectedW),*expectedLong=oracleCyr?(const void*)cyrLongA:(oracleAnsi?(const void*)expectedLongA:(const void*)expectedLongW);
 DWORD expectedSize=oracleCyr?sizeof(cyrA):(oracleAnsi?sizeof(expectedA):sizeof(expectedW)),expectedLongSize=oracleCyr?sizeof(cyrLongA):(oracleAnsi?sizeof(expectedLongA):sizeof(expectedLongW));
 if((type!=3&&type!=5)||size<(type==3?48u:52u))return;
 memcpy(&ptr,buffer+(type==3?32:36),4);memcpy(&flags,buffer+(type==3?44:48),4);if(type==3)memcpy(&count,buffer+12,4);
 memcpy(&dataPtr,buffer+(type==3?16:20),4);memcpy(&dataSize,buffer+(type==3?20:24),4);memcpy(&nameSize,buffer+(type==3?24:28),4);memcpy(&longPtr,buffer+(type==3?36:40),4);memcpy(&parent,buffer+(type==3?40:44),4);
 if((uintptr_t)ptr>=(uintptr_t)buffer&&(uintptr_t)ptr-(uintptr_t)buffer<=size-expectedSize){
  offset=(DWORD)((uintptr_t)ptr-(uintptr_t)buffer);nameok=!memcmp((void*)(uintptr_t)ptr,expected,expectedSize);
 }
 if((uintptr_t)longPtr>=(uintptr_t)buffer&&(uintptr_t)longPtr-(uintptr_t)buffer<=size-expectedLongSize){longOffset=(DWORD)((uintptr_t)longPtr-(uintptr_t)buffer);longok=!memcmp((void*)(uintptr_t)longPtr,expectedLong,expectedLongSize);}
 if(dataSize==sizeof(expectedData)&&(uintptr_t)dataPtr>=(uintptr_t)buffer&&(uintptr_t)dataPtr-(uintptr_t)buffer<=size-sizeof(expectedData)){dataOffset=(DWORD)((uintptr_t)dataPtr-(uintptr_t)buffer);dataok=!memcmp((void*)(uintptr_t)dataPtr,expectedData,sizeof(expectedData));}
 printf("SYSTEM_DETAIL type=%lu size=%lu count=%lu flags=%08lx shortoffset=%lu nameok=%d datasize=%lu dataoffset=%lu dataok=%d namesize=%lu longoffset=%lu longok=%d parent=%lu\n",(unsigned long)type,(unsigned long)size,(unsigned long)count,(unsigned long)flags,(unsigned long)offset,nameok,(unsigned long)dataSize,(unsigned long)dataOffset,dataok,(unsigned long)nameSize,(unsigned long)longOffset,longok,(unsigned long)parent);
}
static HRESULT receive_expected(IDirectPlay4 *play,DPID local,DPID expected,const char *prefix,DWORD nonce,DPID *from_out){
 DWORD until=GetTickCount()+7000;char expected_data[64];int wanted=snprintf(expected_data,sizeof(expected_data),"%s-%lu",prefix,(unsigned long)nonce);
 while((LONG)(GetTickCount()-until)<0){
  BYTE buffer[4096];DWORD size=sizeof(buffer);DPID from=0,to=0;
  HRESULT hr=IDirectPlayX_Receive(play,&from,&to,DPRECEIVE_ALL,buffer,&size);
  if(hr==DPERR_NOMESSAGES){Sleep(10);continue;}
  if(FAILED(hr)){printf("RECEIVE_ERROR %08lx\n",(unsigned long)(DWORD)hr);return hr;}
  if(from==DPID_SYSMSG){DWORD type=0,subtype=0,id=0;if(size>=12){memcpy(&type,buffer,4);memcpy(&subtype,buffer+4,4);memcpy(&id,buffer+8,4);}
   printf("SYSTEM to=%lu size=%lu type=%08lx subtype=%08lx id=%lu\n",(unsigned long)to,(unsigned long)size,(unsigned long)type,(unsigned long)subtype,(unsigned long)id);message_details(buffer,size,type);continue; }
  printf("RECEIVE from=%lu to=%lu size=%lu\n",(unsigned long)from,(unsigned long)to,(unsigned long)size);
  if(to==local&&(!expected||from==expected)&&size==(DWORD)wanted&&!memcmp(buffer,expected_data,wanted)){
   *from_out=from;return DP_OK;
  }
 }
 return DPERR_TIMEOUT;
}
static int receive_destroy(IDirectPlay4 *play,DPID local,DPID expected){
 DWORD until=GetTickCount()+6000;
 while((LONG)(GetTickCount()-until)<0){
  BYTE buffer[4096];DWORD size=sizeof(buffer),type=0,subtype=0,id=0;DPID from=0,to=0;
  HRESULT hr=IDirectPlayX_Receive(play,&from,&to,DPRECEIVE_ALL,buffer,&size);
  if(hr==DPERR_NOMESSAGES){Sleep(10);continue;}if(FAILED(hr))return 0;
  if(from!=DPID_SYSMSG||size<12)continue;
  memcpy(&type,buffer,4);memcpy(&subtype,buffer+4,4);memcpy(&id,buffer+8,4);
  printf("SYSTEM_AFTER to=%lu size=%lu type=%08lx subtype=%08lx id=%lu\n",(unsigned long)to,(unsigned long)size,(unsigned long)type,(unsigned long)subtype,(unsigned long)id);message_details(buffer,size,type);
  if(to==local&&type==5&&subtype==1&&id==expected)return 1;
 }
 return 0;
}
int main(int argc,char **argv){
 IDirectPlayLobby3A *lobby=NULL;IDirectPlay4 *play=NULL;BYTE address[1024];DWORD size=sizeof(address),nonce;
 DPSESSIONDESC2 desc;DPNAME name;DPID own=0,hostid=0,from=0;HRESULT hr;int ishost;char *end;
 if(argc!=5||(strcmp(argv[4],"wide")&&strcmp(argv[4],"ansi")&&strcmp(argv[4],"ansi-cyr")))return 2;oracleCyr=!strcmp(argv[4],"ansi-cyr");oracleAnsi=strcmp(argv[4],"wide")!=0;nonce=(DWORD)strtoul(argv[2],&end,10);if(!nonce||*end)return 2;
 if(oracleCyr&&GetACP()!=1251)return 23;
 ishost=!strcmp(argv[1],"host");if(!ishost&&strcmp(argv[1],"client"))return 2;
 setvbuf(stdout,NULL,_IONBF,0);if(!CreateThread(NULL,0,watchdog,NULL,0,NULL))return 3;
 app.Data1=nonce;printf("PID %lu ROLE %s NONCE %lu\n",(unsigned long)GetCurrentProcessId(),argv[1],(unsigned long)nonce);
 hr=CoInitialize(NULL);printf("COINIT %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 4;
 hr=CoCreateInstance(&CLSID_DirectPlayLobby,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void**)&lobby);
 printf("LOBBY %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 5;
 hr=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,address,&size);
 printf("ADDRESS %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 6;
 hr=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,oracleAnsi?&IID_IDirectPlay4A:&IID_IDirectPlay4,(void**)&play);
 printf("FACTORY %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 7;
 hr=IDirectPlayX_InitializeConnection(play,address,0);printf("INIT %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 8;
 memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication=app;
 if(ishost){desc.dwMaxPlayers=8;desc.lpszSessionName=oracleAnsi?(void*)"DP4-join-oracle":(void*)L"DP4-join-oracle";hr=IDirectPlayX_Open(play,&desc,DPOPEN_CREATE);
  printf("OPEN_CREATE %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 9;
 }else{
  if(!read_ready(argv[3],nonce,&hostid))return 10;
  hr=IDirectPlayX_EnumSessions(play,&desc,2500,enum_session,NULL,0);
  printf("ENUM %08lx matches=%d\n",(unsigned long)(DWORD)hr,matches);if(FAILED(hr)||matches!=1)return 11;
  memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication=app;desc.guidInstance=found;
  hr=IDirectPlayX_Open(play,&desc,DPOPEN_JOIN);printf("OPEN_JOIN %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 12;
 }
 memset(&name,0,sizeof(name));name.dwSize=sizeof(name);name.lpszShortName=oracleAnsi?(void*)(ishost?"Host":(oracleCyr?"\xc8\xe3\xf0\xee\xea":"Client")):(void*)(ishost?L"Host":L"Client");name.lpszLongName=ishost?NULL:(oracleCyr?(void*)"\xc8\xe3\xf0\xee\xea \xd2\xe5\xf1\xf2":(oracleAnsi?(void*)"Client Long":(void*)L"Client Long"));
 {BYTE playerData[]={0x12,0x34,0x56,0x78};hr=IDirectPlayX_CreatePlayer(play,&own,&name,NULL,ishost?NULL:playerData,ishost?0:sizeof(playerData),0);}
 printf("CREATE_PLAYER %08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)own);if(FAILED(hr)||!own)return 13;
 if(ishost){
  if(!ready_write(argv[3],nonce,own))return 14;
  hr=receive_expected(play,own,0,"client",nonce,&from);printf("HOST_RECV %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 15;
  if(!flags_check(play,own,from))return 20;
  char payload[64];int len=snprintf(payload,sizeof(payload),"host-%lu",(unsigned long)nonce);
  hr=IDirectPlayX_Send(play,own,from,DPSEND_GUARANTEED,payload,(DWORD)len);
  printf("HOST_SEND %08lx to=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)from);if(FAILED(hr))return 16;
  if(!receive_destroy(play,own,from))return 22;Sleep(800);
 }else{
  if(!flags_check(play,own,hostid))return 21;
  char payload[64];int len=snprintf(payload,sizeof(payload),"client-%lu",(unsigned long)nonce);
  hr=IDirectPlayX_Send(play,own,hostid,DPSEND_GUARANTEED,payload,(DWORD)len);
  printf("CLIENT_SEND %08lx to=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)hostid);if(FAILED(hr))return 17;
  hr=receive_expected(play,own,hostid,"host",nonce,&from);printf("CLIENT_RECV %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 18;
 }
 hr=IDirectPlayX_DestroyPlayer(play,own);printf("DESTROY %08lx\n",(unsigned long)(DWORD)hr);
 hr=IDirectPlayX_Close(play);printf("CLOSE %08lx\n",(unsigned long)(DWORD)hr);
 IDirectPlayX_Release(play);lobby->lpVtbl->Release(lobby);CoUninitialize();
 return FAILED(hr)?19:0;
}
