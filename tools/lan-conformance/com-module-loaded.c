/* Loader visibility of COM in-process servers; no DirectPlay DLL is statically imported.
 * Compile each wrapper into a fresh process so another class cannot pre-load its server.
 * Snapshot fields: phase, dpnet(A loaded,W loaded,A==W), dplayx(same three fields).
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplay8.h>
#include <dplobby.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef COM_CLASS_KIND
#define COM_CLASS_KIND 0
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count = 3;
static const GUID absent_class = {0x4f5dbc31,0x7f41,0x4be9,{0xa6,0xf2,0x78,0x21,0x59,0x31,0xe0,0x6d}};
static void record(DWORD value) { oracle_results[count++] = value; }
static void module_state(const char *ansi, const WCHAR *wide) {
    HMODULE a = GetModuleHandleA(ansi), w = GetModuleHandleW(wide);
    record(a != 0); record(w != 0); record(a == w);
}
static void snapshot(DWORD phase) {
    record(phase);
    module_state("dpnet.dll", L"dpnet.dll");
    module_state("dplayx.dll", L"dplayx.dll");
}
static void finish(void) {
    DWORD written = 0; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) {
        WriteFile(output, (const void *)oracle_results, count * 4, &written, 0);
        CloseHandle(output);
    }
    ExitProcess(output == INVALID_HANDLE_VALUE || written != count * 4 ? 1 : 0);
}
void entry(void) {
    IUnknown *object = (IUnknown *)0x1234;
    HRESULT hr;
    record(COM_CLASS_KIND);
    snapshot(0);
    record(CoInitialize(0));
    snapshot(1);
    hr = CoCreateInstance(&absent_class, 0, CLSCTX_INPROC_SERVER, &IID_IUnknown, (void **)&object);
    record(hr); record(object == 0);
    snapshot(2);
    object = (IUnknown *)0x1234;
#if COM_CLASS_KIND == 1
    hr = CoCreateInstance(&CLSID_DirectPlay, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay4A, (void **)&object);
#elif COM_CLASS_KIND == 2
    hr = CoCreateInstance(&CLSID_DirectPlayLobby, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlayLobby3A, (void **)&object);
#elif COM_CLASS_KIND == 3
    /* A known class with an unsupported IID is distinct from an unknown class. */
    hr = CoCreateInstance(&CLSID_DirectPlay8Peer, 0, CLSCTX_INPROC_SERVER, &IID_IClassFactory, (void **)&object);
#else
    hr = CoCreateInstance(&CLSID_DirectPlay8Peer, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay8Peer, (void **)&object);
#endif
    record(hr); record(object != 0 && object != (IUnknown *)0x1234);
    snapshot(3);
    if (SUCCEEDED(hr) && object && object != (IUnknown *)0x1234) {
        IUnknown_Release(object); record(1);
    } else record(0);
    snapshot(4);
    CoUninitialize();
    snapshot(5);
    finish();
}
