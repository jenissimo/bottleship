#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count = 3, apcs;
static SOCKET client;
static void record(DWORD value) { oracle_results[count++] = value; }
static void zero(void *value, DWORD size) { unsigned char *p = value; while (size--) *p++ = 0; }
static DWORD WINAPI delayed_send(void *value) { (void)value; Sleep(40); send(client, "abc", 3, 0); return 0; }
static void CALLBACK apc(ULONG_PTR value) { apcs += value; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
void entry(void) {
    WSADATA data; SOCKET listener, server; struct sockaddr_in address; int length, result; OVERLAPPED ov;
    WSABUF buffer; char bytes[8]; DWORD received = 0, flags = 0; HANDLE thread; struct linger reset = {1, 0};
    record(WSAStartup(MAKEWORD(2,2), &data));
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); zero(&address, sizeof(address));
    address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    record(bind(listener, (struct sockaddr *)&address, sizeof(address))); record(listen(listener, 1));
    length = sizeof(address); getsockname(listener, (struct sockaddr *)&address, &length);
    client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); record(connect(client, (struct sockaddr *)&address, sizeof(address)));
    server = accept(listener, 0, 0); record(server != INVALID_SOCKET); closesocket(listener);
    buffer.buf = bytes; buffer.len = sizeof(bytes); zero(&ov, sizeof(ov)); zero(bytes, sizeof(bytes));
    result = WSARecv(server, &buffer, 1, &received, &flags, &ov, 0); record(result); record(WSAGetLastError());
    received = 0xfeed;
    record(GetOverlappedResult((HANDLE)server, &ov, &received, FALSE)); record(GetLastError()); record(received);
    record(GetOverlappedResultEx((HANDLE)server, &ov, &received, 0, FALSE)); record(GetLastError()); record(received);
    record(GetOverlappedResultEx((HANDLE)server, &ov, &received, 15, FALSE)); record(GetLastError()); record(received);
    thread = CreateThread(0, 0, delayed_send, 0, 0, 0);
    record(GetOverlappedResult((HANDLE)server, &ov, &received, TRUE)); record(received);
    record(bytes[0]); record(bytes[1]); record(bytes[2]); record(ov.Internal); record(ov.InternalHigh);
    WaitForSingleObject(thread, 3000); CloseHandle(thread);
    zero(&ov, sizeof(ov)); flags = 0;
    result = WSARecv(server, &buffer, 1, &received, &flags, &ov, 0); record(result); record(WSAGetLastError());
    record(QueueUserAPC(apc, GetCurrentThread(), 1)); received = 0xfeed;
    record(GetOverlappedResultEx((HANDLE)server, &ov, &received, 100, TRUE)); record(GetLastError()); record(apcs); record(received);
    record(CancelIoEx((HANDLE)server, &ov));
    record(GetOverlappedResult((HANDLE)server, &ov, &received, TRUE)); record(GetLastError()); record(received); record(ov.Internal);
    zero(&ov, sizeof(ov)); flags = 0;
    result = WSARecv(server, &buffer, 1, &received, &flags, &ov, 0); record(result); record(WSAGetLastError());
    setsockopt(client, SOL_SOCKET, SO_LINGER, (const char *)&reset, sizeof(reset)); closesocket(client);
    record(GetOverlappedResult((HANDLE)server, &ov, &received, TRUE)); record(GetLastError()); record(received); record(ov.Internal);
    closesocket(server); record(WSACleanup()); finish();
}
