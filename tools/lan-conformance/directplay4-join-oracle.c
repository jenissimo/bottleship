#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
/* Isolated two-process x86 API observation. No capture or service manipulation. */
static GUID app={0,0x7319,0x4ae1,{0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1}};
static GUID found;static int matches;
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
static HRESULT receive_expected(IDirectPlay4 *play,DPID local,DPID expected,const char *prefix,DWORD nonce,DPID *from_out){
 DWORD until=GetTickCount()+7000;char expected_data[64];int wanted=snprintf(expected_data,sizeof(expected_data),"%s-%lu",prefix,(unsigned long)nonce);
 while((LONG)(GetTickCount()-until)<0){
  BYTE buffer[4096];DWORD size=sizeof(buffer);DPID from=0,to=0;
  HRESULT hr=IDirectPlayX_Receive(play,&from,&to,DPRECEIVE_ALL,buffer,&size);
  if(hr==DPERR_NOMESSAGES){Sleep(10);continue;}
  if(FAILED(hr)){printf("RECEIVE_ERROR %08lx\n",(unsigned long)(DWORD)hr);return hr;}
  if(from==DPID_SYSMSG){printf("SYSTEM to=%lu size=%lu\n",(unsigned long)to,(unsigned long)size);continue;}
  printf("RECEIVE from=%lu to=%lu size=%lu\n",(unsigned long)from,(unsigned long)to,(unsigned long)size);
  if(to==local&&(!expected||from==expected)&&size==(DWORD)wanted&&!memcmp(buffer,expected_data,wanted)){
   *from_out=from;return DP_OK;
  }
 }
 return DPERR_TIMEOUT;
}
int main(int argc,char **argv){
 IDirectPlayLobby3A *lobby=NULL;IDirectPlay4 *play=NULL;BYTE address[1024];DWORD size=sizeof(address),nonce;
 DPSESSIONDESC2 desc;DPNAME name;DPID own=0,hostid=0,from=0;HRESULT hr;int ishost;char *end;
 if(argc!=4)return 2;nonce=(DWORD)strtoul(argv[2],&end,10);if(!nonce||*end)return 2;
 ishost=!strcmp(argv[1],"host");if(!ishost&&strcmp(argv[1],"client"))return 2;
 setvbuf(stdout,NULL,_IONBF,0);if(!CreateThread(NULL,0,watchdog,NULL,0,NULL))return 3;
 app.Data1=nonce;printf("PID %lu ROLE %s NONCE %lu\n",(unsigned long)GetCurrentProcessId(),argv[1],(unsigned long)nonce);
 hr=CoInitialize(NULL);printf("COINIT %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 4;
 hr=CoCreateInstance(&CLSID_DirectPlayLobby,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void**)&lobby);
 printf("LOBBY %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 5;
 hr=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,address,&size);
 printf("ADDRESS %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 6;
 hr=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4,(void**)&play);
 printf("FACTORY %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 7;
 hr=IDirectPlayX_InitializeConnection(play,address,0);printf("INIT %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 8;
 memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication=app;
 if(ishost){desc.dwMaxPlayers=8;desc.lpszSessionName=L"DP4-join-oracle";hr=IDirectPlayX_Open(play,&desc,DPOPEN_CREATE);
  printf("OPEN_CREATE %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 9;
 }else{
  if(!read_ready(argv[3],nonce,&hostid))return 10;
  hr=IDirectPlayX_EnumSessions(play,&desc,2500,enum_session,NULL,0);
  printf("ENUM %08lx matches=%d\n",(unsigned long)(DWORD)hr,matches);if(FAILED(hr)||matches!=1)return 11;
  memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication=app;desc.guidInstance=found;
  hr=IDirectPlayX_Open(play,&desc,DPOPEN_JOIN);printf("OPEN_JOIN %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 12;
 }
 memset(&name,0,sizeof(name));name.dwSize=sizeof(name);name.lpszShortName=ishost?L"Host":L"Client";
 hr=IDirectPlayX_CreatePlayer(play,&own,&name,NULL,NULL,0,0);
 printf("CREATE_PLAYER %08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)own);if(FAILED(hr)||!own)return 13;
 if(ishost){
  if(!ready_write(argv[3],nonce,own))return 14;
  hr=receive_expected(play,own,0,"client",nonce,&from);printf("HOST_RECV %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 15;
  char payload[64];int len=snprintf(payload,sizeof(payload),"host-%lu",(unsigned long)nonce);
  hr=IDirectPlayX_Send(play,own,from,DPSEND_GUARANTEED,payload,(DWORD)len);
  printf("HOST_SEND %08lx to=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)from);if(FAILED(hr))return 16;
  Sleep(800);
 }else{
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
