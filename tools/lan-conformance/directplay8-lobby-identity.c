#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count = 3;
static const GUID lobby_class = {0x3b2b6775,0x70b6,0x45af,{0x8d,0xea,0xa2,0x09,0xc6,0x95,0x59,0xf3}};
static const GUID app_class = {0x667955ad,0x6b3b,0x43ca,{0xb9,0x49,0xbc,0x69,0xb5,0xba,0xff,0x7f}};
static const GUID lobby_iid = {0x819074a2,0x016c,0x11d3,{0xae,0x14,0,0x60,0x97,0xb0,0x14,0x11}};
static const GUID app_iid = {0x819074a3,0x016c,0x11d3,{0xae,0x14,0,0x60,0x97,0xb0,0x14,0x11}};
typedef HRESULT (WINAPI *CLASS_FACTORY)(const GUID *, const GUID *, void **);
typedef HRESULT (WINAPI *LOBBY_CREATE)(const GUID *, void **, IUnknown *);
static void record(DWORD value) { oracle_results[count++] = value; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static void identity(IUnknown *unknown, const GUID *iid) {
    IUnknown *same = 0, *primary = 0, *back = 0;
    record(IUnknown_QueryInterface(unknown, &IID_IUnknown, (void **)&same));
    record(same == unknown);
    record(IUnknown_QueryInterface(unknown, iid, (void **)&primary));
    record(primary != unknown);
    if (primary) {
        record(IUnknown_QueryInterface(primary, &IID_IUnknown, (void **)&back)); record(back == unknown);
        if (back) IUnknown_Release(back);
        IUnknown_Release(primary);
    } else { record(777); record(777); }
    if (same) IUnknown_Release(same);
    record(IUnknown_Release(unknown) == 0);
}
static void inspect(CLASS_FACTORY get, LOBBY_CREATE create, const GUID *clsid, const GUID *iid) {
    IClassFactory *factory = 0; IUnknown *unknown = 0; HRESULT hr;
    hr = CoGetClassObject(clsid, CLSCTX_INPROC_SERVER, 0, &IID_IClassFactory, (void **)&factory); record(hr); if (hr) return;
    hr = IClassFactory_CreateInstance(factory, 0, &IID_IUnknown, (void **)&unknown); record(hr);
    if (!hr) identity(unknown, iid);
    IClassFactory_Release(factory);
    unknown = 0;
    hr = CoCreateInstance(clsid, 0, CLSCTX_INPROC_SERVER, &IID_IUnknown, (void **)&unknown); record(hr);
    if (!hr) identity(unknown, iid);
    unknown = 0;
    hr = create(&IID_IUnknown, (void **)&unknown, 0); record(hr); record(unknown != 0);
    if (!hr && unknown) identity(unknown, iid);
}
void entry(void) {
    HMODULE module; CLASS_FACTORY get; LOBBY_CREATE create;
    CoInitialize(0); module = LoadLibraryA("dpnlobby.dll"); record(module != 0); if (!module) finish();
    get = (CLASS_FACTORY)GetProcAddress(module, "DllGetClassObject");
    create = (LOBBY_CREATE)GetProcAddress(module, "DirectPlay8LobbyCreate");
    record(create != 0); if (!create) finish();
    inspect(get, create, &lobby_class, &lobby_iid);
    inspect(get, create, &app_class, &app_iid);
    FreeLibrary(module); CoUninitialize(); finish();
}
