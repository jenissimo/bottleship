#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplay8.h>
#include <dpaddr.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[2048];
static DWORD count = 3;
static unsigned char connection[2048];
static DWORD connection_size;
static BOOL CALLBACK find_tcp(LPCGUID guid, LPVOID data, DWORD size, LPCDPNAME name, DWORD flags, LPVOID context) {
    DWORD i; (void)name; (void)flags; (void)context;
    if (guid->Data1 != DPSPGUID_TCPIP.Data1 || size > sizeof(connection)) return TRUE;
    for (i = 0; i < size; i++) connection[i] = ((unsigned char *)data)[i];
    connection_size = size;
    return FALSE;
}
static void record(DWORD value) { oracle_results[count++] = value; }
static void clear_bytes(void *value, DWORD size) {
    unsigned char *p = (unsigned char *)value; while (size--) *p++ = 0;
}
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) {
        WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output);
    }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static void record_url(IDirectPlay8Address *address) {
    WCHAR url[512]; DWORD size = 512, i, length = 0;
    HRESULT hr = IDirectPlay8Address_GetURLW(address, url, &size);
    record(hr); record(size);
    if (FAILED(hr)) return;
    while (length < 511 && url[length]) length++;
    record(length);
    for (i = 0; i < length; i++) record(url[i]);
}
static void address_edges(void) {
    IDirectPlay8Address *a = 0, *b = 0;
    WCHAR special[] = { 'A',' ','%',';','#','{','}',0x00e9,0x0416,0 };
    WCHAR host[] = { 'h','o','s','t',0 }, uppercase[] = { 'H','O','S','T',0 };
    WCHAR empty[] = { 0 }, key[] = { 'b','l','o','b',0 };
    WCHAR upper_key[] = { 'H','O','S','T','N','A','M','E',0 };
    unsigned char data[] = { 7, 0, 9 }, output[8];
    DWORD port = 2300, size, type, number;
    HRESULT hr;
    record(0xd8000001);
    hr = CoCreateInstance(&CLSID_DirectPlay8Address, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay8Address, (void **)&a);
    record(hr); if (FAILED(hr)) return;
    record(IDirectPlay8Address_SetSP(a, &CLSID_DP8SP_TCPIP));
    record(IDirectPlay8Address_AddComponent(a, DPNA_KEY_HOSTNAME, special, sizeof(special), DPNA_DATATYPE_STRING));
    record_url(a);
    record(0xd8000002);
    size = 0; record(IDirectPlay8Address_GetUserData(a, 0, &size)); record(size);
    record(IDirectPlay8Address_SetUserData(a, data, 3));
    size = 0; record(IDirectPlay8Address_GetUserData(a, 0, &size)); record(size);
    size = 2; output[0] = 55;
    record(IDirectPlay8Address_GetUserData(a, output, &size)); record(size); record(output[0]);
    size = sizeof(output);
    record(IDirectPlay8Address_GetUserData(a, output, &size)); record(size);
    record(output[0]); record(output[1]); record(output[2]);
    record(0xd8000003);
    record(IDirectPlay8Address_AddComponent(a, empty, host, sizeof(host), DPNA_DATATYPE_STRING));
    record(IDirectPlay8Address_AddComponent(a, key, 0, 0, DPNA_DATATYPE_BINARY));
    record(IDirectPlay8Address_AddComponent(a, DPNA_KEY_HOSTNAME, data, sizeof(data), DPNA_DATATYPE_BINARY));
    record(IDirectPlay8Address_AddComponent(a, DPNA_KEY_PORT, &port, 2, DPNA_DATATYPE_DWORD));
    record(IDirectPlay8Address_GetNumComponents(a, &number)); record(number);
    size = sizeof(output); type = 99;
    record(IDirectPlay8Address_GetComponentByName(a, upper_key, output, &size, &type)); record(size); record(type);
    record(0xd8000004);
    IDirectPlay8Address_Clear(a);
    hr = CoCreateInstance(&CLSID_DirectPlay8Address, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay8Address, (void **)&b);
    record(hr);
    if (SUCCEEDED(hr)) {
        IDirectPlay8Address_SetSP(a, &CLSID_DP8SP_TCPIP);
        IDirectPlay8Address_AddComponent(a, DPNA_KEY_HOSTNAME, host, sizeof(host), DPNA_DATATYPE_STRING);
        IDirectPlay8Address_AddComponent(a, DPNA_KEY_PORT, &port, 4, DPNA_DATATYPE_DWORD);
        IDirectPlay8Address_AddComponent(b, DPNA_KEY_PORT, &port, 4, DPNA_DATATYPE_DWORD);
        IDirectPlay8Address_AddComponent(b, DPNA_KEY_HOSTNAME, host, sizeof(host), DPNA_DATATYPE_STRING);
        IDirectPlay8Address_SetSP(b, &CLSID_DP8SP_TCPIP);
        record(IDirectPlay8Address_IsEqual(a, b));
        IDirectPlay8Address_SetEqual(b, a);
        IDirectPlay8Address_AddComponent(b, DPNA_KEY_HOSTNAME, uppercase, sizeof(uppercase), DPNA_DATATYPE_STRING);
        record(IDirectPlay8Address_IsEqual(a, b));
        IDirectPlay8Address_Release(b);
    }
    record(0xd8000005);
    record(IDirectPlay8Address_BuildFromURLA(a, "x-directplay:/hostname=old;port=2300"));
    record_url(a);
    record(IDirectPlay8Address_BuildFromURLA(a, "x-directplay:/hostname=new;port=bad;blob=late"));
    record_url(a);
    record(IDirectPlay8Address_Clear(a));
    record_url(a);
    IDirectPlay8Address_Release(a);
}
void entry(void) {
    IDirectPlay4 *wide = 0;
    IDirectPlay4A *ansi = 0;
    IUnknown *identity_w = 0, *identity_a = 0;
    HRESULT hr;
    DWORD size;
    DWORD aligned[512];
    DPCAPS caps;
    DPSESSIONDESC2 session;
    DPNAME name;
    DPID player;
    WCHAR short_name[] = { 0x041b, 0x0430, 0x043d, 0 };
    WCHAR session_name[] = { 'O','r','a','c','l','e',0 };
    IDirectPlay8Address *address = 0, *duplicate = 0;
    GUID provider;
    WCHAR hostname[] = { 'l','o','c','a','l','h','o','s','t',0 };
    DWORD port = 2300, type, components;

    oracle_results[2] = ORACLE_NONCE;
    record(CoInitialize(0));
    hr = CoCreateInstance(&CLSID_DirectPlay, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay4, (void **)&wide);
    record(hr); /* DP4W factory */
    if (SUCCEEDED(hr)) {
        record(IDirectPlayX_QueryInterface(wide, &IID_IDirectPlay4A, (void **)&ansi));
        record(IDirectPlayX_QueryInterface(wide, &IID_IUnknown, (void **)&identity_w));
        record(IDirectPlayX_QueryInterface(ansi, &IID_IUnknown, (void **)&identity_a));
        record(identity_w == identity_a);
        IUnknown_Release(identity_w); IUnknown_Release(identity_a);
        clear_bytes(&caps, sizeof(caps)); caps.dwSize = sizeof(caps);
        record(IDirectPlayX_GetCaps(wide, &caps, 0)); /* uninitialized */
        record(IDirectPlayX_Initialize(wide, (GUID *)&DPSPGUID_TCPIP));
        record(IDirectPlayX_EnumConnections(wide, &IID_IDirectPlay4, find_tcp, 0, DPCONNECTION_DIRECTPLAY));
        record(connection_size ? 1 : 0);
        record(IDirectPlayX_InitializeConnection(wide, connection, 0));
        clear_bytes(&session, sizeof(session)); session.dwSize = sizeof(session);
        session.guidApplication = IID_IDirectPlay4;
        session.dwMaxPlayers = 8; session.lpszSessionName = session_name;
        hr = IDirectPlayX_Open(wide, &session, DPOPEN_CREATE); record(hr);
        if (SUCCEEDED(hr)) {
            clear_bytes(&name, sizeof(name)); name.dwSize = sizeof(name); name.lpszShortName = short_name;
            hr = IDirectPlayX_CreatePlayer(wide, &player, &name, 0, 0, 0, 0); record(hr);
            if (SUCCEEDED(hr)) {
                size = 0; record(IDirectPlayX_GetPlayerName(wide, player, 0, &size)); record(size);
                size = sizeof(aligned); clear_bytes(aligned, sizeof(aligned));
                record(IDirectPlayX_GetPlayerName(wide, player, aligned, &size)); record(size);
                record(((DPNAME *)aligned)->dwSize);
                record(((DPNAME *)aligned)->lpszShortName[0]);
                record(((DPNAME *)aligned)->lpszShortName[1]);
                record(((DPNAME *)aligned)->lpszShortName[2]);
                size = 0; record(IDirectPlayX_GetPlayerData(wide, player, 0, &size, DPGET_REMOTE)); record(size);
                record(IDirectPlayX_DestroyPlayer(wide, player));
            }
            record(IDirectPlayX_Close(wide));
        }
        IDirectPlayX_Release(ansi); IDirectPlayX_Release(wide);
    }
    hr = CoCreateInstance(&CLSID_DirectPlay8Address, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay8Address, (void **)&address);
    record(hr);
    if (SUCCEEDED(hr)) {
        clear_bytes(&provider, sizeof(provider));
        record(IDirectPlay8Address_GetSP(address, &provider)); /* no SP */
        record(IDirectPlay8Address_SetSP(address, &CLSID_DP8SP_TCPIP));
        record(IDirectPlay8Address_GetSP(address, &provider));
        record(provider.Data1 == CLSID_DP8SP_TCPIP.Data1);
        record(IDirectPlay8Address_AddComponent(address, DPNA_KEY_HOSTNAME, hostname, sizeof(hostname), DPNA_DATATYPE_STRING));
        record(IDirectPlay8Address_AddComponent(address, DPNA_KEY_PORT, &port, sizeof(port), DPNA_DATATYPE_DWORD));
        record(IDirectPlay8Address_GetNumComponents(address, &components)); record(components);
        size = 0; type = 0;
        record(IDirectPlay8Address_GetComponentByName(address, DPNA_KEY_HOSTNAME, 0, &size, &type)); record(size); record(type);
        size = sizeof(aligned);
        record(IDirectPlay8Address_GetComponentByName(address, DPNA_KEY_HOSTNAME, aligned, &size, &type));
        record(size); record(type); record(((WCHAR *)aligned)[0]);
        record(IDirectPlay8Address_Duplicate(address, &duplicate));
        record(IDirectPlay8Address_IsEqual(address, duplicate));
        record(IDirectPlay8Address_Clear(duplicate));
        record(IDirectPlay8Address_IsEqual(address, duplicate));
        IDirectPlay8Address_Release(duplicate);
        size = 0; record(IDirectPlay8Address_GetURLW(address, 0, &size)); record(size);
        IDirectPlay8Address_Release(address);
    }
    address_edges();
    CoUninitialize();
    finish();
}
