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
__declspec(dllexport) volatile DWORD oracle_results[192];
static DWORD count = 3;
static void record(DWORD value) { oracle_results[count++] = value; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
typedef HRESULT (WINAPI *GetClass)(REFCLSID, REFIID, void **);
typedef HRESULT (WINAPI *CanUnload)(void);
static void probe(char *dll, REFCLSID clsid, REFIID iid, DWORD marker) {
    HMODULE module = LoadLibraryA(dll);
    GetClass get; CanUnload unload;
    IClassFactory *factory = 0; IUnknown *object = 0, *identity = 0; void *out;
    HRESULT hr;
    record(marker); record(module != 0); if (!module) return;
    get = (GetClass)GetProcAddress(module, "DllGetClassObject");
    unload = (CanUnload)GetProcAddress(module, "DllCanUnloadNow");
    record(get != 0); record(unload != 0); if (!get || !unload) return;
    record(unload());
    out = (void *)0x1234; hr = get(&IID_IUnknown, &IID_IClassFactory, &out);
    record(hr); record(out == 0);
    out = (void *)0x1234; hr = get(clsid, iid, &out);
    record(hr); record(out == 0);
    hr = get(clsid, &IID_IClassFactory, (void **)&factory);
    record(hr); if (FAILED(hr)) return;
    record(unload());
    record(IClassFactory_QueryInterface(factory, &IID_IUnknown, (void **)&identity));
    record((void *)identity == (void *)factory); if (identity) IUnknown_Release(identity);
    record(IClassFactory_LockServer(factory, TRUE)); record(unload());
    out = (void *)0x1234; hr = IClassFactory_CreateInstance(factory, 0, &IID_IClassFactory, &out);
    record(hr); record(out == 0);
    out = (void *)0x1234; hr = IClassFactory_CreateInstance(factory, (IUnknown *)0x1234, iid, &out);
    record(hr); record(out == 0);
    hr = IClassFactory_CreateInstance(factory, 0, iid, (void **)&object);
    record(hr); if (SUCCEEDED(hr)) { record(unload()); IUnknown_Release(object); }
    record(IClassFactory_LockServer(factory, FALSE));
    IClassFactory_Release(factory);
    record(unload()); FreeLibrary(module);
}
void entry(void) {
    record(CoInitialize(0));
    probe("dplayx.dll", &CLSID_DirectPlay, &IID_IDirectPlay4A, 0xda000001);
    probe("dpnet.dll", &CLSID_DirectPlay8Address, &IID_IDirectPlay8Address, 0xda000002);
    probe("dpnet.dll", &CLSID_DirectPlay8Peer, &IID_IDirectPlay8Peer, 0xda000003);
    CoUninitialize(); finish();
}
