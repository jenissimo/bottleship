#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <svcguid.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count = 3;
static unsigned char storage[16384];
static GUID host_class = SVCID_INET_HOSTADDRBYNAME, unknown_class, different_class = {0x12345678,0,0,{0,0,0,0,0,0,0,0}};
static void record(DWORD value) { oracle_results[count++] = value; }
static void zero(void *data, DWORD size) { unsigned char *p = data; while (size--) *p++ = 0; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static void initial(WSAQUERYSETW *query, AFPROTOCOLS *protocol) {
    zero(query, sizeof(*query)); query->dwSize = sizeof(*query); query->dwNameSpace = NS_DNS;
    query->lpszServiceInstanceName = L"localhost"; query->lpServiceClassId = &host_class;
    protocol->iAddressFamily = AF_INET; protocol->iProtocol = IPPROTO_TCP;
    query->dwNumberOfProtocols = 1; query->lpafpProtocols = protocol;
}
static void variation(DWORD which) {
    WSAQUERYSETW query; AFPROTOCOLS protocol;
    HANDLE handle = (HANDLE)0x11223344; DWORD flags = LUP_RETURN_NAME | LUP_RETURN_ADDR, size = 0; int status, error;
    initial(&query, &protocol);
    switch (which) {
    case 0: query.dwSize = 0; break;
    case 1: query.dwSize = 59; break;
    case 2: query.dwSize = 64; break;
    case 3: query.lpszServiceInstanceName = 0; break;
    case 4: query.lpServiceClassId = 0; break;
    case 5: query.lpServiceClassId = &unknown_class; break;
    case 6: query.dwNameSpace = NS_ALL; break;
    case 7: query.dwNameSpace = 100; break;
    case 8: query.lpNSProviderId = &unknown_class; break;
    case 9: protocol.iAddressFamily = 0; protocol.iProtocol = 0; break;
    case 10: protocol.iAddressFamily = AF_INET6; break;
    case 11: protocol.iProtocol = IPPROTO_ICMP; break;
    case 12: query.lpafpProtocols = 0; break;
    case 13: query.lpszServiceInstanceName = L""; break;
    case 14: flags |= 0x80000000; break;
    case 15: protocol.iAddressFamily = 0; break;
    case 16: protocol.iProtocol = 0; break;
    case 17: query.lpServiceClassId = &different_class; break;
    }
    WSASetLastError(0); status = WSALookupServiceBeginW(&query, flags, &handle); error = status ? WSAGetLastError() : 0;
    record(status); record(error); record(handle == 0); record(handle == (HANDLE)0x11223344);
    if (status == 0) {
        WSASetLastError(0); status = WSALookupServiceNextW(handle, 0, &size, 0);
        record(status); record(WSAGetLastError()); WSALookupServiceEnd(handle);
    } else { record(777); record(777); }
}
static void flush(DWORD flags) {
    WSAQUERYSETW query; AFPROTOCOLS protocol; HANDLE handle; DWORD size = 0; int status;
    initial(&query, &protocol);
    status = WSALookupServiceBeginW(&query, LUP_RETURN_NAME | LUP_RETURN_ADDR, &handle);
    record(status); if (status) return;
    record(WSALookupServiceNextW(handle, 0, &size, 0)); record(WSAGetLastError());
    size = sizeof(storage); WSASetLastError(0);
    record(WSALookupServiceNextW(handle, flags, &size, (WSAQUERYSETW *)storage)); record(WSAGetLastError());
    size = sizeof(storage); WSASetLastError(0);
    record(WSALookupServiceNextW(handle, 0, &size, (WSAQUERYSETW *)storage)); record(WSAGetLastError());
    WSASetLastError(912); record(WSALookupServiceEnd(handle)); record(WSAGetLastError());
}
void entry(void) {
    WSADATA data; DWORD i;
    WSAStartup(MAKEWORD(2, 2), &data);
    for (i = 0; i < 18; i++) variation(i);
    flush(LUP_FLUSHPREVIOUS); flush(0x80000000);
    record(WSACleanup()); finish();
}
