#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static DWORD WINAPI watchdog(void *x){(void)x;Sleep(25000);ExitProcess(124);return 0;}
static GUID app={0,0x7319,0x4ae1,{0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1}};
static GUID wanted;static int found;
static BOOL CALLBACK enumerate(LPCDPSESSIONDESC2 d,LPDWORD timeout,DWORD flags,LPVOID context){
 (void)timeout;(void)context;if(flags&DPESC_TIMEDOUT)return FALSE;
 if(d&&IsEqualGUID(&d->guidApplication,&app)&&IsEqualGUID(&d->guidInstance,&wanted)){found++;return FALSE;}return TRUE;
}
static void drain(IDirectPlay4 *p) {
 BYTE b[4096];DWORD n;DPID from,to;HRESULT h;
 do {n=sizeof(b);from=to=0;h=IDirectPlayX_Receive(p,&from,&to,DPRECEIVE_ALL,b,&n);} while(SUCCEEDED(h));
}
static int observe(IDirectPlay4 *p,DPID a,DPID b,DPID target,DWORD wanted) {
 DWORD deadline=GetTickCount()+5000,mask=0;
 while((LONG)(GetTickCount()-deadline)<0 && mask!=3) {
  BYTE data[4096];DWORD n=sizeof(data),type=0,id=0;DPID from=0,to=0;
  HRESULT h=IDirectPlayX_Receive(p,&from,&to,DPRECEIVE_ALL,data,&n);
  if(h==DPERR_NOMESSAGES){Sleep(5);continue;} if(FAILED(h))return 0;
  if(from!=DPID_SYSMSG||n<12)continue;
  memcpy(&type,data,4);memcpy(&id,data+8,4);
  if(type!=wanted||id!=target)continue;
  printf("OBS type=%lu id=%lu to=%lu size=%lu\n",(unsigned long)type,(unsigned long)id,(unsigned long)to,(unsigned long)n);
  if(to==a)mask|=1;else if(to==b)mask|=2;else return 0;
 }
 printf("MASK type=%lu mask=%lu\n",(unsigned long)wanted,(unsigned long)mask);
 return mask==3;
}
int main(int argc,char **argv) {
 IDirectPlayLobby3A *lobby=NULL;IDirectPlay4 *p=NULL;
 BYTE addr[1024],ready[36];DWORD size=sizeof(addr),got,nonce;HANDLE f;
 DPSESSIONDESC2 d;DPNAME n;DPID a=0,b=0,target;HRESULT h;char cmd[80],*end;int rc=1;
 if(argc!=3)return 2;nonce=(DWORD)strtoul(argv[1],&end,10);if(!nonce||*end)return 2;
 setvbuf(stdout,NULL,_IONBF,0);if(!CreateThread(NULL,0,watchdog,NULL,0,NULL))return 3;
 f=CreateFileA(argv[2],GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,0,NULL);if(f==INVALID_HANDLE_VALUE)return 4;
 if(!ReadFile(f,ready,sizeof(ready),&got,NULL)||got!=sizeof(ready)){CloseHandle(f);return 5;}CloseHandle(f);
 {DWORD magic,record_nonce;memcpy(&magic,ready,4);memcpy(&record_nonce,ready+4,4);if(magic!=0x43485044||record_nonce!=nonce)return 6;}
 app.Data1=nonce;h=CoInitialize(NULL);if(FAILED(h))return 7;
 h=CoCreateInstance(&CLSID_DirectPlayLobby,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void**)&lobby);if(FAILED(h))goto done;
 h=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,addr,&size);if(FAILED(h))goto done;
 h=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4,(void**)&p);if(FAILED(h))goto done;
 h=IDirectPlayX_InitializeConnection(p,addr,0);if(FAILED(h))goto done;
 memset(&d,0,sizeof(d));d.dwSize=sizeof(d);d.guidApplication=app;memcpy(&wanted,ready+16,16);
 h=IDirectPlayX_EnumSessions(p,&d,2500,enumerate,NULL,0);printf("ENUM %08lx found=%d\n",(unsigned long)(DWORD)h,found);if(FAILED(h)||found!=1)goto done;
 d.guidInstance=wanted;
 h=IDirectPlayX_Open(p,&d,DPOPEN_JOIN);printf("JOIN %08lx\n",(unsigned long)(DWORD)h);if(FAILED(h))goto done;
 memset(&n,0,sizeof(n));n.dwSize=sizeof(n);n.lpszShortName=L"Local A";h=IDirectPlayX_CreatePlayer(p,&a,&n,NULL,NULL,0,0);if(FAILED(h))goto done;
 n.lpszShortName=L"Local B";h=IDirectPlayX_CreatePlayer(p,&b,&n,NULL,NULL,0,0);if(FAILED(h))goto done;
 drain(p);printf("CLIENT_READY a=%lu b=%lu\n",(unsigned long)a,(unsigned long)b);
 if(!fgets(cmd,sizeof(cmd),stdin)||sscanf(cmd,"C %lu",(unsigned long*)&target)!=1||!observe(p,a,b,target,3))goto done;
 printf("CREATE_DONE\n");
 if(!fgets(cmd,sizeof(cmd),stdin)||sscanf(cmd,"D %lu",(unsigned long*)&target)!=1||!observe(p,a,b,target,5))goto done;
 printf("DELETE_DONE\n");rc=0;
done:
 if(p){if(b)IDirectPlayX_DestroyPlayer(p,b);if(a)IDirectPlayX_DestroyPlayer(p,a);IDirectPlayX_Close(p);IDirectPlayX_Release(p);}
 if(lobby)lobby->lpVtbl->Release(lobby);CoUninitialize();return rc;
}
