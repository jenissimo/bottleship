#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Isolated x86 API oracle: one potentially malformed call per owned process. */
static DWORD WINAPI watchdog(void *unused) { (void)unused; Sleep(15000); ExitProcess(124); return 0; }
static BOOL CALLBACK enumerated(LPCGUID sp, LPVOID connection, DWORD size, LPCDPNAME name, DWORD flags, LPVOID context) {
    const unsigned char *b=(const unsigned char *)connection; DWORD i;
    (void)context;
    printf("ROW sp="); for(i=0;i<16;i++)printf("%02x",((const unsigned char*)sp)[i]);
    printf(" size=%lu flags=%lu nameSize=%lu nameFlags=%lu bytes=",
      (unsigned long)size,(unsigned long)flags,(unsigned long)(name?name->dwSize:0),(unsigned long)(name?name->dwFlags:0));
    if(size>1024){printf("TOO_LARGE\n");return FALSE;}
    for(i=0;i<size;i++)printf("%02x",b[i]);
    printf("\n");fflush(stdout);return TRUE;
}
int main(int argc,char **argv) {
    IDirectPlayLobby3A *lobby=0; IDirectPlay4 *play=0; BYTE address[1024]; DWORD size=sizeof(address), flags=0;
    HRESULT hr, first=E_NOTIMPL; unsigned i; HANDLE timer;
    if(argc!=2) return 2;
    timer=CreateThread(NULL,0,watchdog,NULL,0,NULL); if(!timer)return 3;
    setvbuf(stdout,NULL,_IONBF,0);
    hr=CoInitialize(NULL); printf("COINIT %08lx\n",(unsigned long)(DWORD)hr); if(FAILED(hr))return 4;
    hr=CoCreateInstance(&CLSID_DirectPlayLobby,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void**)&lobby);
    printf("LOBBY %08lx\n",(unsigned long)(DWORD)hr); if(FAILED(hr))return 5;
    hr=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,address,&size);
    printf("ADDRESS %08lx %lu\n",(unsigned long)(DWORD)hr,(unsigned long)size); if(FAILED(hr)||size>1000||size<60)return 6;
    hr=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4,(void**)&play);
    printf("FACTORY %08lx\n",(unsigned long)(DWORD)hr); if(FAILED(hr))return 7;
    if(!strcmp(argv[1],"enum")) {
        hr=IDirectPlayX_EnumConnections(play,NULL,enumerated,NULL,0);
        printf("ENUM %08lx\n",(unsigned long)(DWORD)hr);
    } else {
        if(!strcmp(argv[1],"already-null-flags")) { first=IDirectPlayX_InitializeConnection(play,address,0); flags=1; }
        if(!strcmp(argv[1],"wrong-guid-flags")) { address[0]^=1; flags=1; }
        else if(!strcmp(argv[1],"null-flags")||!strcmp(argv[1],"valid-flags")) flags=1;
        else if(!strcmp(argv[1],"tail-byte")) { address[size]=0xa5;size++; memcpy(address+20,&size,4); }
        else if(!strcmp(argv[1],"tail-before-sp")) { DWORD bad=0x1000;memcpy(address+24+16,&bad,4); }
        else if(!strcmp(argv[1],"size-23")) { DWORD n=23;memcpy(address+20,&n,4); }
        else if(!strcmp(argv[1],"size-zero")) { DWORD n=0;memcpy(address+20,&n,4); }
        else if(!strcmp(argv[1],"total-chunk-zero")) { DWORD n=0;memcpy(address+16,&n,4); }
        else if(strcmp(argv[1],"valid") && strcmp(argv[1],"already-null-flags") && strcmp(argv[1],"null-flags") && strcmp(argv[1],"valid-flags")) return 8;
        printf("FIRST %08lx\n",(unsigned long)(DWORD)first);
        printf("INPUT size=%lu flags=%lu null=%d bytes=",(unsigned long)size,(unsigned long)flags,
            !strcmp(argv[1],"null-flags")||!strcmp(argv[1],"already-null-flags"));
        for(i=0;i<size;i++)printf("%02x",address[i]);printf("\n");
        hr=IDirectPlayX_InitializeConnection(play,(!strcmp(argv[1],"null-flags")||!strcmp(argv[1],"already-null-flags"))?NULL:address,flags);
        printf("INIT %08lx\n",(unsigned long)(DWORD)hr);
    }
    IDirectPlayX_Release(play); lobby->lpVtbl->Release(lobby); CoUninitialize();
    CloseHandle(timer);return 0;
}
