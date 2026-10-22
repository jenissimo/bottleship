#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

/* Run the same PE on Windows and BottleShip; record API observations, not expectations. */
__declspec(dllexport) volatile DWORD oracle_results[128];
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count = 3;
static SOCKET apc_tx;
static struct sockaddr_in apc_address;
static WSAOVERLAPPED apc_overlapped;
static volatile DWORD apc_count, apc_error, apc_bytes, apc_flags, apc_same_overlapped, apc_same_thread;
static DWORD apc_owner;
static void CALLBACK receive_complete(DWORD error, DWORD bytes, LPWSAOVERLAPPED overlapped, DWORD flags) {
    apc_error = error; apc_bytes = bytes; apc_flags = flags;
    apc_same_overlapped = overlapped == &apc_overlapped;
    apc_same_thread = GetCurrentThreadId() == apc_owner;
    apc_count++;
}
static DWORD WINAPI delayed_send(LPVOID ignored) {
    (void)ignored;
    Sleep(50);
    sendto(apc_tx, "apc", 3, 0, (struct sockaddr *)&apc_address, sizeof(apc_address));
    return 0;
}
static void record(int value) { oracle_results[count++] = (DWORD)value; }
static void clear_bytes(void *value, DWORD size) {
    unsigned char *p = (unsigned char *)value;
    while (size--) *p++ = 0;
}
static void finish(void) {
    DWORD written;
    HANDLE output;
    oracle_results[0] = 0x42534c4e;
    oracle_results[1] = count;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) {
        WriteFile(output, (const void *)oracle_results, count * sizeof(DWORD), &written, 0);
        CloseHandle(output);
    }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}

typedef BOOL (WINAPI *peek_fn)(LPMSG,HWND,UINT,UINT,UINT);
typedef BOOL (WINAPI *post_fn)(DWORD,UINT,WPARAM,LPARAM);
static post_fn post_thread;static volatile DWORD post_result;
static DWORD WINAPI message_send(LPVOID ignored) {
    (void)ignored;Sleep(10);post_result=post_thread(apc_owner,WM_APP+1,17,19);Sleep(50);
    sendto(apc_tx,"msg",3,0,(struct sockaddr*)&apc_address,sizeof(apc_address));return 0;
}
void entry(void) {
    WSADATA data;SOCKET rx;HANDLE thread;int length,r;char buffer[8];MSG message;DWORD timeout=1000;HMODULE user;
    peek_fn peek;oracle_results[2]=ORACLE_NONCE;
    user=LoadLibraryA("user32.dll");peek=(peek_fn)GetProcAddress(user,"PeekMessageA");post_thread=(post_fn)GetProcAddress(user,"PostThreadMessageA");
    record(WSAStartup(MAKEWORD(1,1),&data));apc_owner=GetCurrentThreadId();clear_bytes(&message,sizeof(message));
    record(peek(&message,0,WM_APP+1,WM_APP+1,PM_NOREMOVE));
    rx=socket(AF_INET,SOCK_DGRAM,17);apc_tx=socket(AF_INET,SOCK_DGRAM,17);
    clear_bytes(&apc_address,sizeof(apc_address));apc_address.sin_family=AF_INET;apc_address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    record(bind(rx,(struct sockaddr*)&apc_address,sizeof(apc_address)));length=sizeof(apc_address);getsockname(rx,(struct sockaddr*)&apc_address,&length);
    setsockopt(rx,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);record(WSAUnhookBlockingHook());
    thread=CreateThread(0,0,message_send,0,0,0);r=recv(rx,buffer,3,0);record(r);record(r<0?WSAGetLastError():0);record(buffer[0]);record(buffer[2]);
    WaitForSingleObject(thread,1000);CloseHandle(thread);record(post_result);
    record(peek(&message,0,WM_APP+1,WM_APP+1,PM_REMOVE));record(WSAIsBlocking());
    closesocket(rx);closesocket(apc_tx);record(WSACleanup());finish();
}
