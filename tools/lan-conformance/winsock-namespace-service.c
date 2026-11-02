#define entry unused_namespace_entry
#include "winsock-namespace.c"
#undef entry
static GUID tcp_class = SVCID_TCP(80), udp_class = SVCID_UDP(53);
static void service(GUID *class_id, int protocol_id) {
    WSAQUERYSETW query, *result = (WSAQUERYSETW *)storage; AFPROTOCOLS protocol = {AF_INET, 0};
    HANDLE handle = 0; DWORD size = sizeof(storage), i, mask = 0, ports = 0; int status;
    zero(&query, sizeof(query)); zero(storage, sizeof(storage));
    query.dwSize = sizeof(query); query.dwNameSpace = NS_DNS; query.lpszServiceInstanceName = L"localhost"; query.lpServiceClassId = class_id;
    protocol.iProtocol = protocol_id; query.dwNumberOfProtocols = 1; query.lpafpProtocols = &protocol;
    WSASetLastError(0); status = WSALookupServiceBeginW(&query, LUP_RETURN_TYPE | LUP_RETURN_ADDR, &handle);
    record(status); record(status ? WSAGetLastError() : 0); if (status) { record(777); record(777); record(777); record(777); record(777); return; }
    status = WSALookupServiceNextW(handle, 0, &size, result);
    record(status); record(WSAGetLastError());
    if (!status) {
        for (i = 0; i < result->dwNumberOfCsAddrs; i++) {
            CSADDR_INFO *address = result->lpcsaBuffer + i;
            if (address->iProtocol == IPPROTO_TCP) mask |= 1; if (address->iProtocol == IPPROTO_UDP) mask |= 2;
            if (address->RemoteAddr.lpSockaddr && address->RemoteAddr.lpSockaddr->sa_family == AF_INET) {
                unsigned port = ntohs(((struct sockaddr_in *)address->RemoteAddr.lpSockaddr)->sin_port);
                if (port == 80) ports |= 1; if (port == 53) ports |= 2; if (port == 0) ports |= 4;
            }
        }
        record(mask); record(ports); record(result->lpServiceClassId ? result->lpServiceClassId->Data1 : 0);
    } else { record(777); record(777); record(777); }
    WSALookupServiceEnd(handle);
}
void entry(void) {
    WSADATA data; WSAStartup(MAKEWORD(2, 2), &data);
    service(&tcp_class, IPPROTO_TCP); service(&udp_class, IPPROTO_UDP);
    service(&tcp_class, IPPROTO_UDP); service(&udp_class, IPPROTO_TCP);
    service(&host_class, IPPROTO_TCP);
    record(WSACleanup()); finish();
}
