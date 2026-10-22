#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count = 3;
static void record(DWORD value) { oracle_results[count++] = value; }
static void zero(void *data, DWORD size) { BYTE *p = data; while (size--) *p++ = 0; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
void entry(void) {
    WSADATA startup; SOCKET local, peer; struct sockaddr_in a, b; int length = sizeof(a), result;
    DWORD bytes = 0, completion_bytes = 0; ULONG_PTR key = 0; OVERLAPPED ov, cancelled, *completed = 0;
    HANDLE port; char buffer[16]; DWORD timeout = 1000;
    WSAStartup(MAKEWORD(2, 2), &startup);
    local = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP); peer = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    record(local != INVALID_SOCKET && peer != INVALID_SOCKET);
    setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
    zero(&a, sizeof(a)); a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); b = a;
    record(bind(local, (struct sockaddr *)&a, sizeof(a))); record(bind(peer, (struct sockaddr *)&b, sizeof(b)));
    getsockname(local, (struct sockaddr *)&a, &length); length = sizeof(b); getsockname(peer, (struct sockaddr *)&b, &length);
    record(connect(local, (struct sockaddr *)&b, sizeof(b))); record(connect(peer, (struct sockaddr *)&a, sizeof(a)));
    SetLastError(0); record(WriteFile((HANDLE)local, "abc", 3, &bytes, 0)); record(GetLastError()); record(bytes);
    zero(buffer, sizeof(buffer)); result = recv(peer, buffer, sizeof(buffer), 0); record(result); record(buffer[0]); record(buffer[2]);
    send(peer, "def", 3, 0); zero(buffer, sizeof(buffer)); bytes = 0xfeed; SetLastError(0);
    record(ReadFile((HANDLE)local, buffer, sizeof(buffer), &bytes, 0)); record(GetLastError()); record(bytes); record(buffer[0]); record(buffer[2]);
    record(recv(local, buffer, sizeof(buffer), 0));
    port = CreateIoCompletionPort((HANDLE)local, 0, 42, 0); record(port != 0);
    zero(&ov, sizeof(ov)); ov.hEvent = CreateEventA(0, TRUE, FALSE, 0); zero(buffer, sizeof(buffer)); bytes = 0xfeed; SetLastError(0);
    record(ReadFile((HANDLE)local, buffer, sizeof(buffer), &bytes, &ov)); record(GetLastError()); record(bytes); record((DWORD)ov.Internal);
    send(peer, "ghi", 3, 0);
    record(WaitForSingleObject(ov.hEvent, 1000));
    SetLastError(0); record(GetOverlappedResult((HANDLE)local, &ov, &bytes, FALSE)); record(GetLastError()); record(bytes); record(buffer[0]); record(buffer[2]);
    record(GetQueuedCompletionStatus(port, &completion_bytes, &key, &completed, 1000));
    record(completion_bytes); record(key); record(completed == &ov);
    zero(&cancelled, sizeof(cancelled)); bytes = 0xfeed; SetLastError(0);
    record(ReadFile((HANDLE)local, buffer, sizeof(buffer), &bytes, &cancelled)); record(GetLastError()); record(bytes);
    record(CancelIoEx((HANDLE)local, &cancelled)); SetLastError(0);
    record(GetOverlappedResultEx((HANDLE)local, &cancelled, &bytes, 1000, FALSE)); record(GetLastError()); record(bytes); record((DWORD)cancelled.Internal);
    SetLastError(0); record(GetQueuedCompletionStatus(port, &completion_bytes, &key, &completed, 1000));
    record(GetLastError()); record(completion_bytes); record(key); record(completed == &cancelled);
    record((DWORD)cancelled.Internal); record((DWORD)cancelled.InternalHigh);
    zero(&cancelled, sizeof(cancelled)); bytes = 0xfeed; SetLastError(0);
    record(ReadFile((HANDLE)local, buffer, sizeof(buffer), &bytes, &cancelled)); record(GetLastError());
    record(send(peer, "jkl", 3, 0)); Sleep(50); record((DWORD)cancelled.Internal); record((DWORD)cancelled.InternalHigh);
    record(GetQueuedCompletionStatus(port, &completion_bytes, &key, &completed, 1000));
    record(completion_bytes); record(completed == &cancelled); record((DWORD)cancelled.Internal); record((DWORD)cancelled.InternalHigh);
    zero(&cancelled, sizeof(cancelled)); bytes = 0xfeed; SetLastError(0);
    record(WriteFile((HANDLE)local, "mno", 3, &bytes, &cancelled)); record(GetLastError()); record(bytes); record((DWORD)cancelled.Internal); record((DWORD)cancelled.InternalHigh);
    record(GetQueuedCompletionStatus(port, &completion_bytes, &key, &completed, 1000));
    record(completion_bytes); record((DWORD)cancelled.Internal); record((DWORD)cancelled.InternalHigh);
    record(recv(peer, buffer, sizeof(buffer), 0));
    record(send(peer, "pqr", 3, 0)); Sleep(50);
    zero(&cancelled, sizeof(cancelled)); bytes = 0xfeed; SetLastError(0);
    record(ReadFile((HANDLE)local, buffer, sizeof(buffer), &bytes, &cancelled)); record(GetLastError()); record(bytes); record((DWORD)cancelled.Internal); record((DWORD)cancelled.InternalHigh);
    record(GetQueuedCompletionStatus(port, &completion_bytes, &key, &completed, 1000));
    record(completion_bytes); record((DWORD)cancelled.Internal); record((DWORD)cancelled.InternalHigh);
    CloseHandle(ov.hEvent); CloseHandle(port); closesocket(local); closesocket(peer); record(WSACleanup()); finish();
}
