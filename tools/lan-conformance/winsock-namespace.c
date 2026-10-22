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
static GUID host_class = SVCID_INET_HOSTADDRBYNAME;
static void record(DWORD value) { oracle_results[count++] = value; }
static void zero(void *data, DWORD size) { unsigned char *p = data; while (size--) *p++ = 0; }
static int inside(const void *pointer, DWORD size) { return (const BYTE *)pointer >= storage && (const BYTE *)pointer + size <= storage + sizeof(storage); }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static void lookup(void) {
    WSAQUERYSETW query, *result = (WSAQUERYSETW *)storage;
    AFPROTOCOLS protocol = {AF_INET, IPPROTO_TCP};
    HANDLE handle = (HANDLE)0x11223344; DWORD size = 0, i, found = 0; int status;
    zero(&query, sizeof(query)); query.dwSize = sizeof(query); query.dwNameSpace = NS_DNS;
    query.lpszServiceInstanceName = L"localhost"; query.lpServiceClassId = &host_class;
    query.dwNumberOfProtocols = 1; query.lpafpProtocols = &protocol;
    WSASetLastError(0);
    status = WSALookupServiceBeginW(&query, LUP_RETURN_NAME | LUP_RETURN_TYPE | LUP_RETURN_ADDR | LUP_RETURN_BLOB, &handle);
    record(status); record(WSAGetLastError()); record(handle != 0); if (status) return;
    status = WSALookupServiceNextW(handle, 0, &size, 0);
    record(status); record(WSAGetLastError()); record(size >= sizeof(WSAQUERYSETW));
    size = sizeof(storage); zero(storage, size);
    status = WSALookupServiceNextW(handle, 0, &size, result);
    record(status); record(WSAGetLastError()); record(size); if (!status) {
        record(result->dwSize); record(result->dwNameSpace);
        record(result->dwNumberOfCsAddrs > 0); record(inside(result->lpcsaBuffer, result->dwNumberOfCsAddrs * sizeof(CSADDR_INFO)));
        for (i = 0; i < result->dwNumberOfCsAddrs; i++) {
            CSADDR_INFO *address = result->lpcsaBuffer + i;
            struct sockaddr_in *remote = (struct sockaddr_in *)address->RemoteAddr.lpSockaddr;
            if (address->RemoteAddr.iSockaddrLength >= sizeof(*remote) && inside(remote, sizeof(*remote)) && remote->sin_family == AF_INET && remote->sin_addr.s_addr == htonl(INADDR_LOOPBACK)) found = 1;
        }
        record(found); record(inside(result->lpszServiceInstanceName, 2));
        record(result->lpBlob != 0 && inside(result->lpBlob, sizeof(BLOB)) && inside(result->lpBlob->pBlobData, result->lpBlob->cbSize));
#ifdef ORACLE_LAYOUT
#define REL(pointer) ((pointer) ? (DWORD)((const BYTE *)(pointer) - storage) : 0)
        record(REL(result->lpszServiceInstanceName)); record(REL(result->lpServiceClassId));
        record(REL(result->lpVersion)); record(REL(result->lpszComment)); record(REL(result->lpNSProviderId)); record(REL(result->lpszContext));
        record(result->dwNumberOfProtocols); record(REL(result->lpafpProtocols)); record(REL(result->lpszQueryString));
        record(REL(result->lpcsaBuffer)); record(result->dwOutputFlags); record(REL(result->lpBlob));
        record(REL(result->lpcsaBuffer[0].LocalAddr.lpSockaddr)); record(result->lpcsaBuffer[0].LocalAddr.iSockaddrLength);
        record(REL(result->lpcsaBuffer[0].RemoteAddr.lpSockaddr)); record(result->lpcsaBuffer[0].RemoteAddr.iSockaddrLength);
        record(result->lpcsaBuffer[0].iSocketType); record(result->lpcsaBuffer[0].iProtocol);
        record(result->lpBlob->cbSize); record(REL(result->lpBlob->pBlobData));
        for (i = 0; i < result->lpBlob->cbSize / 4; i++) record(((DWORD *)result->lpBlob->pBlobData)[i]);
        for (i = 0; result->lpszServiceInstanceName && i < 128 && result->lpszServiceInstanceName[i]; i++) record(result->lpszServiceInstanceName[i]); record(0);
        for (i = 0; result->lpszQueryString && i < 128 && result->lpszQueryString[i]; i++) record(result->lpszQueryString[i]); record(0);
#endif
    }
    size = sizeof(storage); status = WSALookupServiceNextW(handle, 0, &size, result);
    record(status); record(WSAGetLastError());
    record(WSALookupServiceEnd(handle)); record(WSALookupServiceEnd(handle)); record(WSAGetLastError());
}
void entry(void) {
    WSADATA data; DWORD size = 0, i; int status, dns = 0;
    WSASetLastError(0); record(WSAEnumNameSpaceProvidersW(&size, 0)); record(WSAGetLastError()); record(size > 0);
    WSAStartup(MAKEWORD(2, 2), &data);
    size = 0; WSASetLastError(0); record(WSAEnumNameSpaceProvidersW(&size, 0)); record(WSAGetLastError()); record(size > 0);
    size = sizeof(storage); status = WSAEnumNameSpaceProvidersW(&size, (WSANAMESPACE_INFOW *)storage);
    record(status > 0); for (i = 0; status > 0 && i < (DWORD)status; i++) if (((WSANAMESPACE_INFOW *)storage)[i].dwNameSpace == NS_DNS) dns = 1;
    record(dns);
    lookup();
    WSASetLastError(0); record(WSALookupServiceBeginW(0, 0, 0)); record(WSAGetLastError());
    record(WSACleanup()); finish();
}
