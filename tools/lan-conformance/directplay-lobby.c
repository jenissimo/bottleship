#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count = 3;
static GUID application = { ORACLE_NONCE, 0x7319, 0x4ae1, {0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1} };
static void clear_bytes(void *value, DWORD size) { unsigned char *p = value; while (size--) *p++ = 0; }
static void record(DWORD value) { oracle_results[count++] = value; }
static int equal_guid(const GUID *a, const GUID *b) { DWORD i; for (i=0;i<16;i++) if (((BYTE *)a)[i] != ((BYTE *)b)[i]) return 0; return 1; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static int is_child(void) {
    char *line = GetCommandLineA(); DWORD i;
    for (i=0;line[i];i++) if (line[i]=='-' && line[i+1]=='-' && line[i+2]=='l' && line[i+3]=='o' && line[i+4]=='b' && line[i+5]=='b' && line[i+6]=='y' && line[i+7]=='-' && line[i+8]=='c') return 1;
    return 0;
}
static HRESULT receive(IDirectPlayLobby3A *lobby, DWORD game, DWORD *flags, void *bytes, DWORD *size, HANDLE event) {
    DWORD deadline = GetTickCount() + 5000; HRESULT hr;
    do {
        hr = lobby->lpVtbl->ReceiveLobbyMessage(lobby,0,game,flags,bytes,size);
        if (hr != DPERR_NOMESSAGES) return hr;
        WaitForSingleObject(event, 25);
    } while ((LONG)(GetTickCount() - deadline) < 0);
    return hr;
}
static void run_child(IDirectPlayLobby3A *lobby) {
    static BYTE buffer[4096]; DWORD flags=99,size=0, i, received[8], report[12]; DPLCONNECTION *settings;
    HANDLE event = CreateEventA(0,FALSE,FALSE,0); HRESULT hr;
    clear_bytes(report,sizeof(report));
    report[0]=0x31415926;
    report[1]=lobby->lpVtbl->GetConnectionSettings(lobby,0,0,&size); report[2]=size;
    size=sizeof(buffer); report[3]=lobby->lpVtbl->GetConnectionSettings(lobby,0,buffer,&size);
    if (SUCCEEDED(report[3])) {
        settings=(DPLCONNECTION *)buffer;
        report[4]=settings->dwFlags; report[5]=equal_guid(&settings->lpSessionDesc->guidApplication,&application);
        report[6]=settings->lpSessionDesc->dwMaxPlayers; report[7]=settings->lpPlayerName && settings->lpPlayerName->lpszShortNameA[0]=='c';
    }
    report[8]=lobby->lpVtbl->SetLobbyMessageEvent(lobby,0,0,event);
    report[9]=GetCurrentProcessId();
    hr=lobby->lpVtbl->SendLobbyMessage(lobby,0,0,report,sizeof(report)); if (FAILED(hr)) ExitProcess(31);
    clear_bytes(received,sizeof(received)); size=sizeof(received); flags=99; hr=receive(lobby,0,&flags,received,&size,event);
    report[0]=0x27182818; report[1]=hr; report[2]=flags; report[3]=size; report[4]=received[0];
    for(i=5;i<12;i++) report[i]=0;
    lobby->lpVtbl->SendLobbyMessage(lobby,0,0,report,sizeof(report));
    lobby->lpVtbl->SetLobbyMessageEvent(lobby,0,0,0); CloseHandle(event);
    lobby->lpVtbl->Release(lobby); CoUninitialize(); ExitProcess(17);
}
void entry(void) {
    IDirectPlayLobby3A *lobby=0; DPAPPLICATIONDESC app; DPLCONNECTION connection; DPSESSIONDESC2 desc; DPNAME player;
    static char path[1024], directory[1024], filename[256], name[80]="BottleShipLanOracle-"; char *hex="0123456789abcdef";
    DWORD length,last=0,i,pid=0,size,flags=99,ack=0x12345678,attempt,found=0; static BYTE buffer[4096], address[512];
    DWORD *report=(DWORD *)buffer, address_size=sizeof(address);
    HANDLE event=0, child_process=0; DWORD child_code=0; HRESULT hr; BOOL registered=FALSE;
    hr=CoInitialize(0);
    hr=CoCreateInstance(&CLSID_DirectPlayLobby,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void **)&lobby);
    if (is_child()) { if (FAILED(hr)) ExitProcess(30); run_child(lobby); }
    record(hr); if (FAILED(hr)) finish();
    length=GetModuleFileNameA(0,path,sizeof(path)); for(i=0;i<length;i++) if(path[i]=='\\' || path[i]=='/') last=i+1;
    for(i=0;i<last;i++) directory[i]=path[i]; directory[last]=0;
    for(i=last;i<=length;i++) filename[i-last]=path[i];
    for(i=0;i<8;i++) name[19+i]=hex[(ORACLE_NONCE >> (28-i*4)) & 15]; name[27]=0;
    clear_bytes(&app,sizeof(app)); app.dwSize=sizeof(app); app.lpszApplicationNameA=name; app.guidApplication=application;
    app.lpszFilenameA=filename; app.lpszPathA=directory; app.lpszCommandLineA="--lobby-child"; app.lpszCurrentDirectoryA=directory;
    hr=lobby->lpVtbl->RegisterApplication(lobby,0,&app); record(hr);
    if (FAILED(hr)) goto cleanup;
    registered=TRUE;
    hr=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,address,&address_size);
    record(hr); if (FAILED(hr)) goto cleanup;
    clear_bytes(&desc,sizeof(desc)); desc.dwSize=sizeof(desc); desc.guidApplication=application; desc.dwMaxPlayers=8; desc.lpszSessionNameA="Lobby oracle";
    clear_bytes(&player,sizeof(player)); player.dwSize=sizeof(player); player.lpszShortNameA="child";
    clear_bytes(&connection,sizeof(connection)); connection.dwSize=sizeof(connection); connection.dwFlags=DPOPEN_CREATE;
    connection.lpSessionDesc=&desc; connection.lpPlayerName=&player; connection.guidSP=DPSPGUID_TCPIP; connection.lpAddress=address; connection.dwAddressSize=address_size;
    event=CreateEventA(0,FALSE,FALSE,0);
    hr=lobby->lpVtbl->RunApplication(lobby,0,&pid,&connection,event); record(hr); record(pid!=0);
    if (FAILED(hr)) goto cleanup;
    record(WaitForSingleObject(event,5000));
    size=0; record(receive(lobby,pid,&flags,0,&size,event)); record(size);
    size=sizeof(buffer); hr=receive(lobby,pid,&flags,buffer,&size,event); record(hr); record(flags); record(size);
    if (FAILED(hr)) goto cleanup;
    record(report[0]); for(i=1;i<=8;i++) record(report[i]);
    record(report[9]==pid); record(report[9]!=GetCurrentProcessId());
    record(lobby->lpVtbl->SendLobbyMessage(lobby,0,pid,&ack,4));
    size=sizeof(buffer); hr=receive(lobby,pid,&flags,buffer,&size,event); record(hr); record(flags); record(size);
    if (SUCCEEDED(hr)) for(i=0;i<5;i++) record(report[i]);
    child_process=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_INFORMATION,FALSE,pid);
    record(child_process!=0);
    if(child_process) { record(WaitForSingleObject(child_process,5000)); record(GetExitCodeProcess(child_process,&child_code)); record(child_code); CloseHandle(child_process); }
    for(attempt=0;attempt<10&&!found;attempt++) {
        size=sizeof(buffer); hr=receive(lobby,pid,&flags,buffer,&size,event);
        if (FAILED(hr)) break;
        if((flags&DPLMSG_SYSTEM) && size==20 && report[0]==DPLSYS_APPTERMINATED) found=1;
    }
    record(found); record(found ? flags : 0); record(found ? size : 0);
cleanup:
    if (event) CloseHandle(event);
    if (registered) record(lobby->lpVtbl->UnregisterApplication(lobby,0,&application));
    lobby->lpVtbl->Release(lobby); CoUninitialize(); finish();
}
