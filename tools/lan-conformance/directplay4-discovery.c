#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>

/* API-only x86 oracle. No CRT, injection, packet rewriting or process control.
   Arguments: host|enum  NONCE_DECIMAL  UNIQUE_OUTPUT_DIR  DURATION_MS  match|mismatch.
   A coordinator owns the two processes and the output directory. */
#define MAX_ROWS 64
#define NAME_CHARS 96
#define RESULT_MAGIC 0x344f5044u
#define READY_MAGIC 0x34525044u

typedef struct {
    DWORD ordinal, flags, timeout, has_desc, size, session_flags;
    GUID instance, application;
    DWORD max_players, current_players, name_length, name_truncated;
    WCHAR name[NAME_CHARS];
} EnumRow;
typedef struct {
    DWORD magic, version, nonce, role, pid, duration_ms, mismatch;
    HRESULT coinit_hr, lobby_hr, address_hr, factory_hr, init_hr, open_hr;
    HRESULT create_player_hr, enum_hr, close_hr;
    DWORD row_count, rows_dropped;
    EnumRow rows[MAX_ROWS];
} Result;
typedef struct { DWORD magic, nonce, pid; HRESULT open_hr, create_player_hr; } Ready;
static Result result;
static char args[6][512], output_path[768], ready_path[768], timeout_path[768];
static BYTE connection[1024];
static DWORD nonce, duration, row_count, stage_failures;
static HANDLE completed, watchdog_rearm;
static CRITICAL_SECTION rows_lock;

static void zero(void *dst, DWORD n) { BYTE *p = (BYTE *)dst; while (n--) *p++ = 0; }
static int equal(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return *a == *b; }
static int parse_number(const char *s, DWORD *out) {
    DWORD n = 0; if (!*s) return 0;
    while (*s) {
        DWORD d; if (*s < '0' || *s > '9') return 0;
        d = (DWORD)(*s++ - '0'); if (n > (0xffffffffu - d) / 10u) return 0;
        n = n * 10u + d;
    }
    *out = n; return 1;
}
/* Bounded quoting for executable and each argument; no shell expansion. */
static int arguments(void) {
    const char *p = GetCommandLineA(); DWORD count = 0;
    while (*p) {
        DWORD n = 0; int quoted = 0;
        while (*p == ' ' || *p == '\t') p++;
        if (!*p) break;
        if (count >= 6) return 0;
        if (*p == '"') { quoted = 1; p++; }
        while (*p && (quoted ? *p != '"' : *p != ' ' && *p != '\t')) {
            if (n >= sizeof(args[0]) - 1) return 0;
            args[count][n++] = *p++;
        }
        if (quoted) { if (*p != '"') return 0; p++; if (*p && *p != ' ' && *p != '\t') return 0; }
        args[count][n] = 0; count++;
    }
    return count == 6;
}
static int make_path(char *dst, const char *dir, const char *name) {
    DWORD i = 0, j = 0;
    while (dir[i]) { if (i >= 700) return 0; dst[i] = dir[i]; i++; }
    if (!i) return 0;
    if (dst[i-1] != '\\' && dst[i-1] != '/') dst[i++] = '\\';
    while (name[j]) { if (i >= 767) return 0; dst[i++] = name[j++]; }
    dst[i] = 0; return 1;
}
static int write_new(const char *path, const void *data, DWORD size) {
    DWORD written = 0; HANDLE file = CreateFileA(path, GENERIC_WRITE, 0, 0, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, 0);
    int ok;
    if (file == INVALID_HANDLE_VALUE) return 0;
    ok = WriteFile(file, data, size, &written, 0) && written == size;
    CloseHandle(file); return ok;
}
/* Each marker is immutable and survives a later blocked native call. */
static void stage(DWORD code, HRESULT hr) {
    char name[] = "host-stage-00.bin", path[768]; DWORD marker[6], i;
    for (i = 0; i < 4; i++) name[i] = args[1][i];
    name[11] = (char)('0' + code / 10); name[12] = (char)('0' + code % 10);
    marker[0] = 0x34535044u; marker[1] = nonce; marker[2] = GetCurrentProcessId();
    marker[3] = code; marker[4] = GetTickCount(); marker[5] = (DWORD)hr;
    if (!make_path(path, args[3], name) || !write_new(path, marker, sizeof(marker))) stage_failures++;
}
static DWORD WINAPI watchdog(void *ignored) {
    DWORD marker[4], wait, limit = result.role == 1 ? 20000 : duration + 20000;
    HANDLE events[2]; (void)ignored;
    events[0] = completed; events[1] = watchdog_rearm;
    for (;;) {
        wait = WaitForMultipleObjects(2, events, FALSE, limit);
        if (wait == WAIT_OBJECT_0) return 0;
        if (wait == WAIT_OBJECT_0 + 1) { limit = duration + 10000; continue; }
        if (wait == WAIT_TIMEOUT) {
            marker[0] = 0x34545044u; marker[1] = nonce; marker[2] = GetCurrentProcessId(); marker[3] = GetTickCount();
            write_new(timeout_path, marker, sizeof(marker)); ExitProcess(124);
        }
        ExitProcess(125);
    }
}
static BOOL CALLBACK on_session(LPCDPSESSIONDESC2 desc, LPDWORD timeout, DWORD flags, LPVOID context) {
    DWORD index, length = 0; EnumRow *row; (void)context;
    EnterCriticalSection(&rows_lock);
    index = row_count++;
    if (index >= MAX_ROWS) { result.rows_dropped++; LeaveCriticalSection(&rows_lock); return FALSE; }
    row = &result.rows[index]; zero(row, sizeof(*row));
    row->ordinal = index; row->flags = flags; row->timeout = timeout ? *timeout : 0;
    if (desc) {
        row->has_desc = 1; row->size = desc->dwSize; row->session_flags = desc->dwFlags;
        row->instance = desc->guidInstance; row->application = desc->guidApplication;
        row->max_players = desc->dwMaxPlayers; row->current_players = desc->dwCurrentPlayers;
        if (desc->lpszSessionName) {
            while (length < NAME_CHARS - 1 && desc->lpszSessionName[length]) {
                row->name[length] = desc->lpszSessionName[length]; length++;
            }
            row->name_truncated = length == NAME_CHARS - 1 && desc->lpszSessionName[length] != 0;
        }
        row->name_length = length;
    }
    /* DPESC_TIMEDOUT ends this finite synchronous enumeration pass. */
    LeaveCriticalSection(&rows_lock); return (flags & DPESC_TIMEDOUT) ? FALSE : TRUE;
}
void entry(void) {
    IDirectPlayLobby3A *lobby = 0; IDirectPlay4 *play = 0;
    DPSESSIONDESC2 desc; DPNAME player_name; DPID player_id = 0;
    GUID application = { 0, 0x7319, 0x4ae1, {0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1} };
    WCHAR session_name[] = { 'D','P','4','-','o','r','a','c','l','e',0x0416,0 };
    WCHAR player_label[] = { 'H','o','s','t',0 };
    DWORD connection_size = sizeof(connection), mode, mismatch, wait_ms;
    HRESULT hr; HANDLE timer; Ready ready; int ready_written = 1;
    if (!arguments() || !parse_number(args[2], &nonce) || !nonce ||
        !parse_number(args[4], &duration) || duration < 1000 || duration > 10000) ExitProcess(2);
    mode = equal(args[1], "host") ? 1 : equal(args[1], "enum") ? 2 : 0;
    mismatch = equal(args[5], "mismatch") ? 1 : equal(args[5], "match") ? 0 : 2;
    if (!mode || mismatch > 1 || (mode == 1 && mismatch)) ExitProcess(2);
    if (!make_path(output_path, args[3], mode == 1 ? "host-result.bin" : "enum-result.bin") ||
        !make_path(timeout_path, args[3], mode == 1 ? "host-timeout.bin" : "enum-timeout.bin") ||
        (mode == 1 && !make_path(ready_path, args[3], "host-ready.bin"))) ExitProcess(2);
    zero(&result, sizeof(result));
    result.magic = RESULT_MAGIC; result.version = 1; result.nonce = nonce; result.role = mode;
    result.pid = GetCurrentProcessId(); result.duration_ms = duration; result.mismatch = mismatch;
    result.coinit_hr = result.lobby_hr = result.address_hr = result.factory_hr = result.init_hr = E_NOTIMPL;
    result.open_hr = result.create_player_hr = result.enum_hr = result.close_hr = E_NOTIMPL;
    InitializeCriticalSection(&rows_lock);
    completed = CreateEventA(0, TRUE, FALSE, 0); if (!completed) ExitProcess(3);
    watchdog_rearm = CreateEventA(0, FALSE, FALSE, 0); if (!watchdog_rearm) ExitProcess(3);
    timer = CreateThread(0, 0, watchdog, 0, 0, 0); if (!timer) ExitProcess(3);
    stage(1, E_NOTIMPL); result.coinit_hr = CoInitialize(0); stage(2, result.coinit_hr);
    if (FAILED(result.coinit_hr)) goto finish;
    stage(3, E_NOTIMPL);
    result.lobby_hr = CoCreateInstance(&CLSID_DirectPlayLobby, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlayLobby3A, (void **)&lobby);
    stage(4, result.lobby_hr); if (FAILED(result.lobby_hr)) goto uninit;
    stage(5, E_NOTIMPL);
    result.address_hr = lobby->lpVtbl->CreateAddress(lobby, &DPSPGUID_TCPIP, &DPAID_INet,
        "127.0.0.1", 10, connection, &connection_size);
    stage(6, result.address_hr); if (FAILED(result.address_hr)) goto release_lobby;
    stage(7, E_NOTIMPL);
    result.factory_hr = CoCreateInstance(&CLSID_DirectPlay, 0, CLSCTX_INPROC_SERVER, &IID_IDirectPlay4, (void **)&play);
    stage(8, result.factory_hr); if (FAILED(result.factory_hr)) goto release_lobby;
    stage(9, E_NOTIMPL); result.init_hr = IDirectPlayX_InitializeConnection(play, connection, 0);
    stage(10, result.init_hr); if (FAILED(result.init_hr)) goto release_play;
    application.Data1 = nonce ^ (mismatch ? 1u : 0u);
    zero(&desc, sizeof(desc)); desc.dwSize = sizeof(desc); desc.guidApplication = application;
    if (mode == 1) {
        desc.dwMaxPlayers = 8; desc.lpszSessionName = session_name;
        stage(11, E_NOTIMPL); result.open_hr = IDirectPlayX_Open(play, &desc, DPOPEN_CREATE); stage(12, result.open_hr);
        if (SUCCEEDED(result.open_hr)) {
            zero(&player_name, sizeof(player_name)); player_name.dwSize = sizeof(player_name); player_name.lpszShortName = player_label;
            stage(13, E_NOTIMPL); result.create_player_hr = IDirectPlayX_CreatePlayer(play, &player_id, &player_name, 0, 0, 0, 0);
            stage(14, result.create_player_hr);
        }
        ready.magic = READY_MAGIC; ready.nonce = nonce; ready.pid = GetCurrentProcessId();
        ready.open_hr = result.open_hr; ready.create_player_hr = result.create_player_hr;
        ready_written = write_new(ready_path, &ready, sizeof(ready));
        if (ready_written && !SetEvent(watchdog_rearm)) ready_written = 0;
        if (ready_written && SUCCEEDED(result.open_hr)) { wait_ms = duration; WaitForSingleObject(completed, wait_ms); }
        if (player_id) { stage(21, E_NOTIMPL); hr = IDirectPlayX_DestroyPlayer(play, player_id); stage(22, hr); }
        if (SUCCEEDED(result.open_hr)) { stage(17, E_NOTIMPL); result.close_hr = IDirectPlayX_Close(play); stage(18, result.close_hr); }
    } else {
        /* Synchronous finite enumeration. No callback fields are retained as pointers. */
        stage(15, E_NOTIMPL); result.enum_hr = IDirectPlayX_EnumSessions(play, &desc, duration, on_session, 0, 0);
        stage(16, result.enum_hr);
        stage(17, E_NOTIMPL); result.close_hr = IDirectPlayX_Close(play); stage(18, result.close_hr);
    }
release_play:
    if (play) IDirectPlayX_Release(play);
release_lobby:
    if (lobby) lobby->lpVtbl->Release(lobby);
uninit:
    stage(19, E_NOTIMPL); CoUninitialize(); stage(20, S_OK);
finish:
    result.row_count = row_count < MAX_ROWS ? row_count : MAX_ROWS;
    hr = write_new(output_path, &result, sizeof(result)) && ready_written && !stage_failures ? S_OK : E_FAIL;
    SetEvent(completed); WaitForSingleObject(timer, 1000); CloseHandle(timer); CloseHandle(watchdog_rearm); CloseHandle(completed);
    DeleteCriticalSection(&rows_lock);
    ExitProcess(FAILED(hr) ? 4 : 0);
}
