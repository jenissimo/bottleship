#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0600
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[192];
static DWORD count = 3;
static SOCKET receiver;
static HANDLE port, ready, release_worker;
static OVERLAPPED operation;
static WSABUF buffer;
static char payload[16];
static DWORD worker_result, worker_error;
static void record(DWORD value) { oracle_results[count++] = value; }
static void clear_bytes(void *value, DWORD size) { BYTE *p = value; while (size--) *p++ = 0; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static DWORD WINAPI foreign_cancel(void *unused) {
    worker_result = CancelIo((HANDLE)receiver);
    worker_error = worker_result ? 0 : GetLastError();
    return 0;
}
static DWORD WINAPI foreign_receive(void *unused) {
    DWORD bytes = 0, flags = 0;
    worker_result = WSARecv(receiver, &buffer, 1, &bytes, &flags, &operation, 0);
    worker_error = worker_result == SOCKET_ERROR ? WSAGetLastError() : 0;
    SetEvent(ready);
    WaitForSingleObject(release_worker, 3000);
    return 0;
}
static DWORD WINAPI foreign_dequeue(void *unused) {
    DWORD bytes = 123; ULONG_PTR key = 456; OVERLAPPED *overlapped = (OVERLAPPED *)789;
    SetEvent(ready);
    worker_result = GetQueuedCompletionStatus(port, &bytes, &key, &overlapped, 2000);
    worker_error = GetLastError();
    return 0;
}
static void prepare_receive(void) {
    DWORD bytes = 0, flags = 0;
    clear_bytes(&operation, sizeof(operation));
    buffer.buf = payload; buffer.len = sizeof(payload);
    record(WSARecv(receiver, &buffer, 1, &bytes, &flags, &operation, 0));
    record(WSAGetLastError());
}
static void dequeue(DWORD timeout) {
    DWORD bytes = 123; ULONG_PTR key = 456; OVERLAPPED *overlapped = (OVERLAPPED *)789;
    BOOL ok = GetQueuedCompletionStatus(port, &bytes, &key, &overlapped, timeout);
    record(ok); record(ok ? 0 : GetLastError());
    record(overlapped == &operation); record(overlapped == 0);
    if (overlapped) { record(bytes); record((DWORD)key); }
}
void entry(void) {
    WSADATA startup; struct sockaddr_in address; DWORD bytes, flags;
    HANDLE thread, other; BOOL ok;
    record(WSAStartup(MAKEWORD(2,2), &startup));
    receiver = WSASocketA(AF_INET, SOCK_DGRAM, IPPROTO_UDP, 0, 0, WSA_FLAG_OVERLAPPED);
    record(receiver != INVALID_SOCKET); if (receiver == INVALID_SOCKET) finish();
    clear_bytes(&address, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    record(bind(receiver, (struct sockaddr *)&address, sizeof(address)));
    port = CreateIoCompletionPort((HANDLE)receiver, 0, 0x1234, 0); record(port != 0); if (!port) finish();
    ok = CreateIoCompletionPort((HANDLE)receiver, port, 0x5678, 0) == port; record(ok); record(ok ? 0 : GetLastError());
    other = CreateIoCompletionPort(INVALID_HANDLE_VALUE, 0, 0, 0); record(other != 0);
    ok = CreateIoCompletionPort((HANDLE)receiver, other, 0, 0) != 0;
    record(ok); record(ok ? 0 : GetLastError()); CloseHandle(other);
    prepare_receive();
    thread = CreateThread(0, 0, foreign_cancel, 0, 0, 0); record(thread != 0);
    record(WaitForSingleObject(thread, 3000)); CloseHandle(thread);
    record(worker_result); record(worker_error);
    dequeue(0);
    record(CancelIo((HANDLE)receiver)); dequeue(2000);
    bytes = flags = 0; record(WSAGetOverlappedResult(receiver, &operation, &bytes, FALSE, &flags)); record(WSAGetLastError());
    prepare_receive();
    { OVERLAPPED unknown; clear_bytes(&unknown, sizeof(unknown)); ok = CancelIoEx((HANDLE)receiver, &unknown); record(ok); record(ok ? 0 : GetLastError()); }
    record(CancelIoEx((HANDLE)receiver, &operation)); dequeue(2000);
    clear_bytes(&operation, sizeof(operation));
    ready = CreateEventA(0, TRUE, FALSE, 0); release_worker = CreateEventA(0, TRUE, FALSE, 0);
    thread = CreateThread(0, 0, foreign_receive, 0, 0, 0); record(thread != 0);
    record(WaitForSingleObject(ready, 3000)); record(worker_result); record(worker_error);
    record(CancelIo((HANDLE)receiver)); dequeue(0);
    record(CancelIoEx((HANDLE)receiver, 0)); dequeue(2000);
    SetEvent(release_worker); record(WaitForSingleObject(thread, 3000)); CloseHandle(thread);
    ResetEvent(ready);
    prepare_receive();
    thread = CreateThread(0, 0, foreign_dequeue, 0, 0, 0); record(thread != 0);
    record(WaitForSingleObject(ready, 3000)); Sleep(30);
    SetLastError(0x2468); record(CancelIoEx((HANDLE)receiver, &operation));
    record(WaitForSingleObject(thread, 3000)); record(GetLastError()); CloseHandle(thread);
    record(worker_result); record(worker_error);
    record(CancelIo((HANDLE)receiver));
    ok = CancelIoEx((HANDLE)receiver, 0); record(ok); record(ok ? 0 : GetLastError());
    CloseHandle(ready); CloseHandle(release_worker);
    closesocket(receiver); CloseHandle(port); WSACleanup(); finish();
}
