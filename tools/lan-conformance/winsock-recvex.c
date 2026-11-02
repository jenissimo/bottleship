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

typedef int (WINAPI *recv_ex_fn)(SOCKET,char*,int,int*);
void entry(void) {
    WSADATA data; SOCKET rx,tx; struct sockaddr_in address; int length,r,flags; char buffer[32]; u_long one=1;
    recv_ex_fn receive=(recv_ex_fn)GetProcAddress(LoadLibraryA("wsock32.dll"),"WSARecvEx");
    oracle_results[2]=ORACLE_NONCE;record(WSAStartup(MAKEWORD(2,2),&data));record(receive!=0);
    rx=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);tx=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);
    clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    record(bind(rx,(struct sockaddr*)&address,sizeof(address)));length=sizeof(address);getsockname(rx,(struct sockaddr*)&address,&length);
    record(sendto(tx,"abcdefgh",8,0,(struct sockaddr*)&address,sizeof(address)));
    clear_bytes(buffer,sizeof(buffer));flags=0;WSASetLastError(177);r=receive(rx,buffer,3,&flags);
    record(r);record(WSAGetLastError());record(flags);record(buffer[0]);record(buffer[2]);
    ioctlsocket(rx,FIONBIO,&one);flags=0;WSASetLastError(178);r=receive(rx,buffer,8,&flags);
    record(r);record(WSAGetLastError());record(flags);
    record(sendto(tx,"xyz",3,0,(struct sockaddr*)&address,sizeof(address)));
    flags=MSG_PEEK;WSASetLastError(179);r=receive(rx,buffer,8,&flags);
    record(r);record(WSAGetLastError());record(flags);record(buffer[0]);record(buffer[2]);
    flags=0;r=receive(rx,buffer,8,&flags);record(r);record(flags);
    closesocket(rx);closesocket(tx);record(WSACleanup());finish();
}
