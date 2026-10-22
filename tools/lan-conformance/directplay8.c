#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#include <dpaddr.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count = 3;
static void record(DWORD value) { oracle_results[count++] = value; }
static void clear_bytes(void *value, DWORD size) { unsigned char *p = value; while (size--) *p++ = 0; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static HANDLE created, received;
static volatile DWORD create_count, receive_count, destroy_count, payload_size, payload_first, callback_context;
static volatile DPNID local_player;
static volatile DPNHANDLE retained;
static HRESULT WINAPI handler(PVOID context, DWORD message, PVOID data) {
    callback_context = context == (PVOID)0x1234;
    if (message == DPN_MSGID_CREATE_PLAYER) {
        DPNMSG_CREATE_PLAYER *create = data;
        local_player = create->dpnidPlayer; create_count++;
        SetEvent(created);
    } else if (message == DPN_MSGID_RECEIVE) {
        DPNMSG_RECEIVE *receive = data;
        receive_count++; payload_size = receive->dwReceiveDataSize;
        payload_first = receive->dwReceiveDataSize ? receive->pReceiveData[0] : 0;
        retained = receive->hBufferHandle; SetEvent(received);
        return DPNSUCCESS_PENDING;
    } else if (message == DPN_MSGID_DESTROY_PLAYER) destroy_count++;
    return S_OK;
}
static void sample_caps(IDirectPlay8Peer *peer, DWORD marker, BOOL change) {
    DPN_CAPS caps; DPN_CAPS_EX extended; DPN_SP_CAPS provider;
    HRESULT hr; DWORD i;
    record(marker);
    clear_bytes(&caps, sizeof(caps)); caps.dwSize = sizeof(caps);
    hr = IDirectPlay8Peer_GetCaps(peer, &caps, 0); record(hr);
    if (SUCCEEDED(hr)) for (i = 0; i < sizeof(caps) / 4; i++) record(((DWORD *)&caps)[i]);
    clear_bytes(&extended, sizeof(extended)); extended.dwSize = sizeof(extended);
    hr = IDirectPlay8Peer_GetCaps(peer, (DPN_CAPS *)&extended, 0); record(hr);
    if (SUCCEEDED(hr)) for (i = 0; i < sizeof(extended) / 4; i++) record(((DWORD *)&extended)[i]);
    clear_bytes(&provider, sizeof(provider)); provider.dwSize = sizeof(provider);
    hr = IDirectPlay8Peer_GetSPCaps(peer, &CLSID_DP8SP_TCPIP, &provider, 0); record(hr);
    if (SUCCEEDED(hr)) {
        record(provider.dwSize); record(provider.dwFlags); record(provider.dwNumThreads > 0);
        record(provider.dwDefaultEnumCount); record(provider.dwDefaultEnumRetryInterval); record(provider.dwDefaultEnumTimeout);
        record(provider.dwMaxEnumPayloadSize); record(provider.dwBuffersPerThread); record(provider.dwSystemBufferSize);
    }
    if (change) {
        clear_bytes(&caps, sizeof(caps)); caps.dwSize = sizeof(caps);
        caps.dwConnectTimeout = 1234; caps.dwConnectRetries = 3; caps.dwTimeoutUntilKeepAlive = 7777;
        record(IDirectPlay8Peer_SetCaps(peer, &caps, 0));
        clear_bytes(&caps, sizeof(caps)); caps.dwSize = sizeof(caps);
        record(IDirectPlay8Peer_GetCaps(peer, &caps, 0));
        record(caps.dwConnectTimeout); record(caps.dwConnectRetries); record(caps.dwTimeoutUntilKeepAlive);
    }
}
void entry(void) {
    IDirectPlay8Peer *peer = 0;
    IDirectPlay8Address *address = 0, *addresses[32];
    DPN_APPLICATION_DESC application;
    DPN_PLAYER_INFO info;
    DPN_BUFFER_DESC buffer;
    DWORD size, number;
    WCHAR name[] = { 'H','o','s','t',0 };
    HRESULT hr;
    PVOID context;
    DWORD storage[256];
    record(CoInitialize(0));
    created = CreateEventA(0, TRUE, FALSE, 0); received = CreateEventA(0, TRUE, FALSE, 0);
    hr = CoCreateInstance(&CLSID_DirectPlay8Peer, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay8Peer, (void **)&peer);
    record(hr); if (FAILED(hr)) finish();
    sample_caps(peer, 0xd9000001, FALSE);
    record(IDirectPlay8Peer_Initialize(peer, (PVOID)0x1234, handler, 0));
    sample_caps(peer, 0xd9000002, TRUE);
    clear_bytes(&info, sizeof(info)); info.dwSize = sizeof(info); info.dwInfoFlags = DPNINFO_NAME; info.pwszName = name;
    record(IDirectPlay8Peer_SetPeerInfo(peer, &info, 0, 0, DPNSETPEERINFO_SYNC));
    hr = CoCreateInstance(&CLSID_DirectPlay8Address, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay8Address, (void **)&address);
    record(hr); if (FAILED(hr)) finish();
    record(IDirectPlay8Address_SetSP(address, &CLSID_DP8SP_TCPIP));
    clear_bytes(&application, sizeof(application)); application.dwSize = sizeof(application);
    application.guidApplication = IID_IDirectPlay8Peer; application.dwMaxPlayers = 4; application.pwszSessionName = name;
    hr = IDirectPlay8Peer_Host(peer, &application, &address, 1, 0, 0, (PVOID)0x5678, 0);
    record(hr); if (FAILED(hr)) finish();
    record(WaitForSingleObject(created, 5000)); record(create_count); record(callback_context);
    size = 0; record(IDirectPlay8Peer_GetApplicationDesc(peer, 0, &size, 0)); record(size);
    size = sizeof(storage); clear_bytes(storage, sizeof(storage)); ((DPN_APPLICATION_DESC *)storage)->dwSize = sizeof(DPN_APPLICATION_DESC);
    hr = IDirectPlay8Peer_GetApplicationDesc(peer, (DPN_APPLICATION_DESC *)storage, &size, 0); record(hr);
    if (FAILED(hr)) finish();
    record(((DPN_APPLICATION_DESC *)storage)->dwMaxPlayers);
    record(((DPN_APPLICATION_DESC *)storage)->dwCurrentPlayers);
    size = 0; record(IDirectPlay8Peer_GetPeerInfo(peer, local_player, 0, &size, 0)); record(size);
    size = sizeof(storage); clear_bytes(storage, sizeof(storage)); ((DPN_PLAYER_INFO *)storage)->dwSize = sizeof(DPN_PLAYER_INFO);
    hr = IDirectPlay8Peer_GetPeerInfo(peer, local_player, (DPN_PLAYER_INFO *)storage, &size, 0); record(hr);
    if (FAILED(hr)) finish();
    record((((DPN_PLAYER_INFO *)storage)->dwPlayerFlags & DPNPLAYER_LOCAL) != 0);
    record((((DPN_PLAYER_INFO *)storage)->dwPlayerFlags & DPNPLAYER_HOST) != 0);
    record(((DPN_PLAYER_INFO *)storage)->pwszName ? ((DPN_PLAYER_INFO *)storage)->pwszName[0] : 0xffffffff);
    context = 0; record(IDirectPlay8Peer_GetPlayerContext(peer, local_player, &context, 0)); record((DWORD)context);
    number = 0; record(IDirectPlay8Peer_GetLocalHostAddresses(peer, 0, &number, 0)); record(number > 0);
    clear_bytes(addresses, sizeof(addresses));
    number = 32; hr = IDirectPlay8Peer_GetLocalHostAddresses(peer, addresses, &number, 0); record(hr);
    if (FAILED(hr)) finish();
    record(number > 0);
    while (number) { number--; if (addresses[number]) IDirectPlay8Address_Release(addresses[number]); }
    buffer.dwBufferSize = 3; buffer.pBufferData = (BYTE *)"net";
    hr = IDirectPlay8Peer_SendTo(peer, local_player, &buffer, 1, 0, 0, 0, DPNSEND_SYNC | DPNSEND_GUARANTEED); record(hr);
    if (FAILED(hr)) finish();
    record(WaitForSingleObject(received, 5000)); record(receive_count); record(payload_size); record(payload_first);
    record(IDirectPlay8Peer_ReturnBuffer(peer, retained, 0));
    record(IDirectPlay8Peer_Close(peer, 0)); record(destroy_count);
    IDirectPlay8Address_Release(address); IDirectPlay8Peer_Release(peer);
    CloseHandle(created); CloseHandle(received); CoUninitialize(); finish();
}
