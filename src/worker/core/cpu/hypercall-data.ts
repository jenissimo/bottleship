/**
 * HypercallDataManager — manages the shared HYPERCALL_PAGE data between
 * JS and WASM for fast in-WASM thunk dispatch.
 *
 * Writes time data (tick count, QPC) before each tick, reads back
 * lastError after context switches, and manages the dispatch table.
 */

import { TimeService } from '../../runtime/time';
import { Logger, LogCategory } from '../logger';
import { System } from '../system';
import { EMU_MEMORY_SIZE } from './emulator-config';
import { TARGET_INSN_PER_MS, TARGET_MIPS_PER_US } from '../scheduler/timing';
import {
    EVENT_TABLE_SLOTS,
    EVT_VALID,
    EVT_SIGNALED,
    EVT_MANUAL,
    EVT_HAS_WAITERS,
    EVT_PENDING_WAKE,
    OFF_HC_EVENT_TABLE,
    OFF_HC_EVENT_STARVATION_COUNTER,
    OFF_HC_EVENT_STARVATION_LIMIT,
    OFF_HC_MUTEX_MIRROR_PTR,
    MUX_VALID,
    MUX_HAS_WAITERS,
    mutexMirrorValuesInRange,
    packMutexMirrorWord,
    unpackMutexMirrorWord,
    eventSlotForKernelHandle,
} from './hypercall-event-mirror';

// Offsets within HYPERCALL_PAGE (must match hypercall.rs)
const OFF_CYCLE_LIMIT = 0x000;
const OFF_HC_ENABLED = 0x008;
const OFF_HC_CALL_COUNT = 0x00C;
const OFF_HC_TICK_COUNT = 0x010;
const OFF_HC_PERF_COUNTER_LO = 0x014;
const OFF_HC_PERF_COUNTER_HI = 0x018;
const OFF_HC_PERF_FREQ_LO = 0x01C;
const OFF_HC_PERF_FREQ_HI = 0x020;
const OFF_HC_LAST_ERROR = 0x024;
const OFF_HC_TEB_BASE = 0x028;
const OFF_HC_INSN_AT_TIME_UPDATE = 0x02C;
const OFF_HC_MIPS_ESTIMATE = 0x030;
const OFF_HC_CURRENT_THREAD_ID = 0x034;
// Per-handler_id accounting written by try_dispatch (must match hypercall.rs).
// 256 slots each, u32, saturating — see getHandlerReport().
const OFF_HC_HANDLER_CALLS = 0x2000;
const OFF_HC_HANDLER_FALLBACKS = 0x2400;
/** 32 slots of (thread handle, suspend count) — see publishThreadSuspendCounts. */
const OFF_HC_THREAD_SUSPEND = 0x2800;
const HC_THREAD_SUSPEND_SLOTS = 32;
const HC_HANDLER_SLOTS = 256;
const OFF_HC_CURSOR_X = 0x080;
const OFF_HC_CURSOR_Y = 0x084;
const OFF_HC_WINDOW_X = 0x088;
const OFF_HC_WINDOW_Y = 0x08C;
const OFF_HC_MSG_QUEUE_FLAG = 0x090;
const OFF_HC_PEEK_STARVATION_COUNTER = 0x094;
const OFF_HC_PEEK_STARVATION_LIMIT = 0x098;
const OFF_HC_HAS_RUNNABLE_PEERS = 0x09C;  // 1 when other threads are READY/RUNNING
const OFF_HC_SLEEP_STARVATION_COUNTER = 0x0A0;
const OFF_HC_SLEEP_STARVATION_LIMIT = 0x0A4;
const OFF_HC_RAND_SEED = 0x0B0;
// Mouse-capture owner (GetCapture). 0 is a LEGITIMATE answer, not an "unpublished"
// sentinel, so the WASM handler cannot fall through on it — the page must therefore be
// authoritative at all times: published at init, on every capture mutation, and on
// buffer-change resync (rewriteState).
const OFF_HC_CAPTURE_HWND = 0x0B4;
const OFF_HC_DISPATCH_TABLE = 0x100;
const OFF_HC_FLS_ALLOCATED = 0x1100; // 129 bytes, one allocation flag per FLS slot (slot 0 unused)
const OFF_HC_FLS_VALUES = 0x1184;    // 129 * u32 slot values
// EAGL token-dispatch config pointer (handler 132) — must match hypercall.rs.
const OFF_HC_EAGL_TOKEN_CFG_PTR = 0x1C54;
const HC_FLS_SLOT_COUNT = 129;

// Handler IDs (must match hypercall.rs match arms)
const HANDLER_GET_TICK_COUNT = 1;
const HANDLER_GET_TICK_COUNT64 = 2;
const HANDLER_QPC = 3;
const HANDLER_QPF = 4;
const HANDLER_GET_LAST_ERROR = 5;
const HANDLER_SET_LAST_ERROR = 6;
const HANDLER_INTERLOCKED_INC = 7;
const HANDLER_INTERLOCKED_DEC = 8;
const HANDLER_INTERLOCKED_XCHG = 9;
const HANDLER_INTERLOCKED_CMP_XCHG = 10;
const HANDLER_ENTER_CS = 11;
const HANDLER_LEAVE_CS = 12;
const HANDLER_IS_ICONIC = 13;
const HANDLER_SCREEN_TO_CLIENT = 14;
const HANDLER_GET_CURSOR_POS = 15;
const HANDLER_PEEK_MESSAGE = 16;
// Math/FPU hypercalls (Tier 2)
const HANDLER_FTOL = 17;
const HANDLER_CI_SIN = 18;
const HANDLER_CI_COS = 19;
const HANDLER_CI_TAN = 20;
const HANDLER_CI_SQRT = 21;
const HANDLER_CI_LOG = 22;
const HANDLER_CI_EXP = 23;
const HANDLER_CI_ACOS = 24;
const HANDLER_CI_ASIN = 25;
const HANDLER_CI_LOG10 = 26;
const HANDLER_CI_ATAN2 = 27;
const HANDLER_CI_FMOD = 28;
const HANDLER_CI_POW = 29;
const HANDLER_CDECL_SIN = 30;
const HANDLER_CDECL_COS = 31;
const HANDLER_CDECL_TAN = 32;
const HANDLER_CDECL_SQRT = 33;
const HANDLER_CDECL_LOG = 34;
const HANDLER_CDECL_EXP = 35;
const HANDLER_CDECL_ACOS = 36;
const HANDLER_CDECL_ASIN = 37;
const HANDLER_CDECL_LOG10 = 38;
const HANDLER_CDECL_ATAN = 39;
const HANDLER_CDECL_FABS = 40;
const HANDLER_CDECL_ATAN2 = 41;
const HANDLER_CDECL_FMOD = 42;
const HANDLER_CDECL_POW = 43;
const HANDLER_CDECL_CEIL = 44;
const HANDLER_CDECL_FLOOR = 45;
// String/memory hypercalls (Tier 3)
const HANDLER_WCSLEN = 51;
const HANDLER_WCSCPY = 52;
const HANDLER_WCSCAT = 53;
const HANDLER_WCSICMP = 54;
const HANDLER_WCSCHR = 55;
const HANDLER_MEMCPY = 56;
const HANDLER_MEMSET = 57;
const HANDLER_STRLEN = 58;
const HANDLER_STRCMP = 59;
const HANDLER_STRCPY = 60;
const HANDLER_STRICMP = 61;
const HANDLER_MEMCMP = 62;
// Scheduler hypercalls (Tier 4)
const HANDLER_SLEEP = 63;
const HANDLER_TLS_GET_VALUE = 64;
// Additional string/stdlib hypercalls
const HANDLER_RAND = 65;
const HANDLER_WCSSTR = 66;
const HANDLER_WCSNICMP = 67;
const HANDLER_WCSNCPY = 68;
const HANDLER_FLS_GET_VALUE = 69;
// Heap arena hypercalls (Tier 5)
const HANDLER_HEAP_ALLOC = 70;
const HANDLER_HEAP_FREE = 71;
const HANDLER_SET_EVENT = 72;
// Tier 1/3 additions
const HANDLER_GET_CURRENT_THREAD_ID = 73;
const HANDLER_STRNICMP = 74;
const HANDLER_STRSTR = 75;
const HANDLER_ATOI = 76;
const HANDLER_RT_DYNAMIC_CAST = 77;
// Page-probe pointer validation (hypercall.rs handle_is_bad_ptr; one probe serves both ids)
const HANDLER_IS_BAD_READ_PTR = 78;
const HANDLER_IS_BAD_WRITE_PTR = 79;
const HANDLER_RELEASE_MUTEX = 80;
const HANDLER_WAIT_FOR_SINGLE_OBJECT = 81;
const HANDLER_GET_CAPTURE = 82;
const HANDLER_RESUME_THREAD = 83;

/**
 * Inner-loop HLE handler-id band (128..=255) — engine compute kernels, kept
 * distinct from the WinAPI/CRT tiers (1..=127) so the dispatch byte names the
 * category. Keep in lockstep with the Rust match in `cpu/hypercall.rs`.
 */
export const HANDLER_EAGL_SHADER_CONVERT = 128;
// EAGL shader-parameter APPLY converter family (libs/eagl/apply-kernels.ts):
export const HANDLER_EAGL_APPLY_REG_INT = 129;   // FUN_005c85c1 int→float, register layout
export const HANDLER_EAGL_APPLY_REG_FLOAT = 130; // FUN_005c8303 float/copy+ftol, register layout
export const HANDLER_EAGL_APPLY_PACKED = 131;    // FUN_005cad01 float/copy+ftol, packed layout
// EAGL→D3D9 state-token dispatcher, hot classes 1/2/8 (libs/eagl/token-dispatch.ts).
// Config block pointer at OFF_HC_EAGL_TOKEN_CFG_PTR.
export const HANDLER_EAGL_TOKEN_DISPATCH = 132;
// Batch boundaries (same cfg block, version 3):
export const HANDLER_EAGL_COMMIT_CLUSTER = 133; // FUN_005d02d7 → FUN_005cf304 dirty-list walk
export const HANDLER_EAGL_PASS_DRIVER = 134;    // FUN_005d01ec pass-commit element loop

// Arena slab control offsets (must match hypercall.rs)
export const OFF_HC_SLAB_BASE = 0x1400;
export const OFF_HC_SLAB_END = 0x1404;
export const OFF_HC_SLAB_BUMP = 0x1408;
const OFF_HC_SLAB_GENERATION = 0x140C;
export const OFF_HC_SLAB_ALLOC_COUNT = 0x1410;
export const OFF_HC_SLAB_FREE_COUNT = 0x1414;
const OFF_HC_SLAB_FALLBACK_COUNT = 0x1418;
export const OFF_HC_SLAB_FREELIST = 0x1420; // 9 × u32
// Guest address of the slab control block (0 = legacy page mode). The WASM heap handler reads
// this to find the guest-RAM control block; JS writes it in setSlabControlAddr / rewriteState.
const OFF_HC_SLAB_CTL_PTR = 0x1444;

/** Map from "dllname.functionname" (lowercase) to handler ID.
 *
 * Time-query and sync fast-paths are handled in WASM.
 * EnterCS/LeaveCS return false for contended/full-release cases,
 * falling through to JS for scheduler wait/wake.
 * SetEvent fast-path handles no-waiter signals in WASM; JS wakes waiters.
 * Interlocked, GetLastError, SetLastError stay in JS — too frequent,
 * starves onThunkComplete() and breaks thread scheduling.
 */
/** Hypercall handlers that WRITE guest memory from Rust — the set the diagnostic
 *  switch can force back to JS so a write trap can observe them. */
const WASM_WRITE_HANDLERS = new Set<number>([
    HANDLER_WCSCPY, HANDLER_WCSCAT, HANDLER_WCSNCPY,
    HANDLER_MEMCPY, HANDLER_MEMSET, HANDLER_STRCPY,
]);

const HANDLER_MAP: Record<string, number> = {
    'kernel32.gettickcount': HANDLER_GET_TICK_COUNT,
    'kernel32.gettickcount64': HANDLER_GET_TICK_COUNT64,
    'winmm.timegettime': HANDLER_GET_TICK_COUNT,
    'kernel32.queryperformancecounter': HANDLER_QPC,
    'kernel32.queryperformancefrequency': HANDLER_QPF,
    'kernel32.entercriticalsection': HANDLER_ENTER_CS,
    'kernel32.leavecriticalsection': HANDLER_LEAVE_CS,
    'user32.isiconic': HANDLER_IS_ICONIC,
    // NOTE: ScreenToClient is intentionally NOT hypercall-dispatched. The WASM
    // handler (handle_screen_to_client) subtracts a single global window offset
    // (OFF_HC_WINDOW_X/Y, only ever set to (0,0) — see emulator.worker.ts
    // updateWindowData) and ignores the HWND argument, so it is an identity no-op
    // that fails to convert coordinates for CHILD windows (e.g. owner-draw buttons
    // at a non-zero parent-relative origin). The JS handler in user32/window.ts does
    // the correct per-HWND conversion (pt - win.x/win.y). Keep it on the JS path.
    // 'user32.screentoclient': HANDLER_SCREEN_TO_CLIENT,
    'user32.getcursorpos': HANDLER_GET_CURSOR_POS,
    // GetCapture — pure page read of the capture owner (WindowManager publishes it on
    // every mutation). No args, no scheduler state; onTickHook compensates the skipped
    // onThunkComplete exactly as it does for GetLastError/GetCurrentThreadId. Games poll
    // this per frame from their input loop.
    'user32.getcapture': HANDLER_GET_CAPTURE,
    'user32.peekmessagea': HANDLER_PEEK_MESSAGE,
    'user32.peekmessagew': HANDLER_PEEK_MESSAGE,
    'kernel32.sleep': HANDLER_SLEEP,
    'kernel32.setevent': HANDLER_SET_EVENT,
    'kernel32.releasemutex': HANDLER_RELEASE_MUTEX,
    'kernel32.waitforsingleobject': HANDLER_WAIT_FOR_SINGLE_OBJECT,
    // ResumeThread — the WASM handler answers ONLY a resume of a thread that is not suspended
    // (returns 0, changes nothing); everything else falls through to the scheduler. Engines
    // that kick a worker once per main-loop iteration make this one of the hottest thunks
    // there is (Discworld Noir: ~270k calls/s, virtually all of them no-ops).
    'kernel32.resumethread': HANDLER_RESUME_THREAD,
    // GetCurrentThreadId — pure read of the page's current-thread-id (republished on every
    // context switch). Read-only, no scheduler state touched; onTickHook compensates the
    // skipped onThunkComplete the same as GetLastError. Hot via the CRT's _getptd().
    'kernel32.getcurrentthreadid': HANDLER_GET_CURRENT_THREAD_ID,
    'kernel32.tlsgetvalue': HANDLER_TLS_GET_VALUE,
    'kernel32.flsgetvalue': HANDLER_FLS_GET_VALUE,
    // Pointer validation via page probe (EA titles call these per-pointer in hot loops).
    // Read-only probe; falls back to JS on any probe fault (decommit/CoW disambiguation).
    'kernel32.isbadreadptr': HANDLER_IS_BAD_READ_PTR,
    'kernel32.isbadwriteptr': HANDLER_IS_BAD_WRITE_PTR,
    'kernel32.isbadhugereadptr': HANDLER_IS_BAD_READ_PTR,
    'kernel32.isbadhugewriteptr': HANDLER_IS_BAD_WRITE_PTR,
    // Interlocked/LastError — safe with onTickHook() compensating for skipped onThunkComplete()
    'kernel32.getlasterror': HANDLER_GET_LAST_ERROR,
    'kernel32.setlasterror': HANDLER_SET_LAST_ERROR,
    'kernel32.interlockedincrement': HANDLER_INTERLOCKED_INC,
    'kernel32.interlockeddecrement': HANDLER_INTERLOCKED_DEC,
    'kernel32.interlockedexchange': HANDLER_INTERLOCKED_XCHG,
    'kernel32.interlockedcompareexchange': HANDLER_INTERLOCKED_CMP_XCHG,

    // Math/FPU hypercalls — msvcrt + crtdll
    'msvcrt._ftol': HANDLER_FTOL,
    'crtdll._ftol': HANDLER_FTOL,
    'msvcrt._cisin': HANDLER_CI_SIN,
    'crtdll._cisin': HANDLER_CI_SIN,
    'msvcrt._cicos': HANDLER_CI_COS,
    'crtdll._cicos': HANDLER_CI_COS,
    'msvcrt._citan': HANDLER_CI_TAN,
    'crtdll._citan': HANDLER_CI_TAN,
    'msvcrt._cisqrt': HANDLER_CI_SQRT,
    'crtdll._cisqrt': HANDLER_CI_SQRT,
    'msvcrt._cilog': HANDLER_CI_LOG,
    'crtdll._cilog': HANDLER_CI_LOG,
    'msvcrt._ciexp': HANDLER_CI_EXP,
    'crtdll._ciexp': HANDLER_CI_EXP,
    'msvcrt._ciacos': HANDLER_CI_ACOS,
    'crtdll._ciacos': HANDLER_CI_ACOS,
    'msvcrt._ciasin': HANDLER_CI_ASIN,
    'crtdll._ciasin': HANDLER_CI_ASIN,
    'msvcrt._cilog10': HANDLER_CI_LOG10,
    'crtdll._cilog10': HANDLER_CI_LOG10,
    'msvcrt._ciatan2': HANDLER_CI_ATAN2,
    'crtdll._ciatan2': HANDLER_CI_ATAN2,
    'msvcrt._cifmod': HANDLER_CI_FMOD,
    'crtdll._cifmod': HANDLER_CI_FMOD,
    'msvcrt._cipow': HANDLER_CI_POW,
    'crtdll._cipow': HANDLER_CI_POW,
    'msvcrt.sin': HANDLER_CDECL_SIN,
    'crtdll.sin': HANDLER_CDECL_SIN,
    'msvcrt.cos': HANDLER_CDECL_COS,
    'crtdll.cos': HANDLER_CDECL_COS,
    'msvcrt.tan': HANDLER_CDECL_TAN,
    'crtdll.tan': HANDLER_CDECL_TAN,
    'msvcrt.sqrt': HANDLER_CDECL_SQRT,
    'crtdll.sqrt': HANDLER_CDECL_SQRT,
    'msvcrt.log': HANDLER_CDECL_LOG,
    'crtdll.log': HANDLER_CDECL_LOG,
    'msvcrt.exp': HANDLER_CDECL_EXP,
    'crtdll.exp': HANDLER_CDECL_EXP,
    'msvcrt.acos': HANDLER_CDECL_ACOS,
    'crtdll.acos': HANDLER_CDECL_ACOS,
    'msvcrt.asin': HANDLER_CDECL_ASIN,
    'crtdll.asin': HANDLER_CDECL_ASIN,
    'msvcrt.log10': HANDLER_CDECL_LOG10,
    'crtdll.log10': HANDLER_CDECL_LOG10,
    'msvcrt.atan': HANDLER_CDECL_ATAN,
    'crtdll.atan': HANDLER_CDECL_ATAN,
    'msvcrt.fabs': HANDLER_CDECL_FABS,
    'crtdll.fabs': HANDLER_CDECL_FABS,
    'msvcrt.atan2': HANDLER_CDECL_ATAN2,
    'crtdll.atan2': HANDLER_CDECL_ATAN2,
    'msvcrt.fmod': HANDLER_CDECL_FMOD,
    'crtdll.fmod': HANDLER_CDECL_FMOD,
    'msvcrt.pow': HANDLER_CDECL_POW,
    'crtdll.pow': HANDLER_CDECL_POW,
    'msvcrt.ceil': HANDLER_CDECL_CEIL,
    'crtdll.ceil': HANDLER_CDECL_CEIL,
    'msvcrt.floor': HANDLER_CDECL_FLOOR,
    'crtdll.floor': HANDLER_CDECL_FLOOR,

    // kernel32 lstr* → reuse CRT string handlers (same arg layout)
    'kernel32.lstrlena': HANDLER_STRLEN,
    'kernel32.lstrlenw': HANDLER_WCSLEN,
    'kernel32.lstrcpya': HANDLER_STRCPY,
    'kernel32.lstrcpyw': HANDLER_WCSCPY,
    'kernel32.lstrcatw': HANDLER_WCSCAT,
    'kernel32.lstrcmpa': HANDLER_STRCMP,
    'kernel32.lstrcmpia': HANDLER_STRICMP,
    'kernel32.lstrcmpiw': HANDLER_WCSICMP,

    // String/memory hypercalls — msvcrt + crtdll
    'msvcrt.wcslen': HANDLER_WCSLEN,
    'crtdll.wcslen': HANDLER_WCSLEN,
    'msvcrt.wcscpy': HANDLER_WCSCPY,
    'crtdll.wcscpy': HANDLER_WCSCPY,
    'msvcrt.wcscat': HANDLER_WCSCAT,
    'crtdll.wcscat': HANDLER_WCSCAT,
    'msvcrt._wcsicmp': HANDLER_WCSICMP,
    'crtdll._wcsicmp': HANDLER_WCSICMP,
    'msvcrt.wcschr': HANDLER_WCSCHR,
    'crtdll.wcschr': HANDLER_WCSCHR,
    'msvcrt.memcpy': HANDLER_MEMCPY,
    'crtdll.memcpy': HANDLER_MEMCPY,
    'msvcrt.memset': HANDLER_MEMSET,
    'crtdll.memset': HANDLER_MEMSET,
    'msvcrt.strlen': HANDLER_STRLEN,
    'crtdll.strlen': HANDLER_STRLEN,
    'msvcrt.strcmp': HANDLER_STRCMP,
    'crtdll.strcmp': HANDLER_STRCMP,
    'msvcrt.strcpy': HANDLER_STRCPY,
    'crtdll.strcpy': HANDLER_STRCPY,
    'msvcrt._stricmp': HANDLER_STRICMP,
    'msvcrt._strcmpi': HANDLER_STRICMP,
    'crtdll._stricmp': HANDLER_STRICMP,
    'crtdll._strcmpi': HANDLER_STRICMP,
    'msvcrt.memcmp': HANDLER_MEMCMP,
    'crtdll.memcmp': HANDLER_MEMCMP,
    // Narrow ANSI string leaves — _strnicmp (count==0 → equal, NARROW convention), strstr, atoi/atol
    'msvcrt._strnicmp': HANDLER_STRNICMP,
    'crtdll._strnicmp': HANDLER_STRNICMP,
    'msvcrt.strstr': HANDLER_STRSTR,
    'crtdll.strstr': HANDLER_STRSTR,
    'msvcrt.atoi': HANDLER_ATOI,
    'crtdll.atoi': HANDLER_ATOI,
    'msvcrt.atol': HANDLER_ATOI,
    'crtdll.atol': HANDLER_ATOI,
    'msvcrt.__rtdynamiccast': HANDLER_RT_DYNAMIC_CAST,
    'crtdll.__rtdynamiccast': HANDLER_RT_DYNAMIC_CAST,
    // Additional string/stdlib hypercalls
    'msvcrt.rand': HANDLER_RAND,
    'crtdll.rand': HANDLER_RAND,
    'msvcrt.wcsstr': HANDLER_WCSSTR,
    'crtdll.wcsstr': HANDLER_WCSSTR,
    'msvcrt._wcsnicmp': HANDLER_WCSNICMP,
    'crtdll._wcsnicmp': HANDLER_WCSNICMP,
    'msvcrt.wcsncpy': HANDLER_WCSNCPY,
    'crtdll.wcsncpy': HANDLER_WCSNCPY,
    // Heap arena hypercalls
    'kernel32.heapalloc': HANDLER_HEAP_ALLOC,
    'kernel32.heapfree': HANDLER_HEAP_FREE,
};

// Mirror msvcrt hypercall entries for msvcr90 (VC9 CRT alias).
for (const key of Object.keys(HANDLER_MAP)) {
    if (key.startsWith('msvcrt.')) {
        const alias = `msvcr90.${key.slice(7)}`;
        if (!(alias in HANDLER_MAP)) {
            HANDLER_MAP[alias] = HANDLER_MAP[key];
        }
    }
}

/** QPF = 1 MHz (matches TimeService convention) */
const PERF_FREQ = 1_000_000;

/**
 * Virtual time constants.
 * v86 targets LOOP_COUNTER (100,003) instructions per 1ms tick (TIME_PER_FRAME=1.0).
 * We derive game-visible time from instruction count rather than wall-clock,
 * preventing large dt spikes when the emulator runs slower than real-time.
 */
const MAX_VIRTUAL_DELTA_MS = 4; // safety cap per tick
// hard clamp: virtual time can't lead wall clock by more than this. Shared with the
// scheduler's Sleep-credit path (creditIdleMs) via TimeService — single source of truth
// so no advance path can violate the ceiling the other paths assume.
const MAX_AHEAD_MS = TimeService.MAX_AHEAD_MS;

export class HypercallDataManager {
    private hpBase = 0;
    // Guest-RAM address of the slab control block (BASE/END/BUMP/GEN/counts/FREELIST[9]),
    // laid out at the SAME relative offsets as the HYPERCALL_PAGE slab fields minus
    // OFF_HC_SLAB_BASE. 0 = legacy mode (use the HYPERCALL_PAGE static directly).
    //
    // WHY this exists: the inline x86 HeapAlloc/HeapFree stubs read these fields via
    // absolute guest memory operands. The HYPERCALL_PAGE is a Rust static placed BELOW
    // guest RAM in WASM linear memory (hpBase < mem8 byteOffset), so it is NOT reachable
    // from guest code at all — a guest access to `hpBase+OFF` resolves to guest-physical
    // `hpBase+OFF` (inside the loaded image), reading/writing garbage. The control block
    // therefore MUST live in guest RAM so the inline stub, JS and (future) WASM agree on
    // one physical location.
    private slabControlAddr = 0;
    private wasmMemory: ArrayBuffer | null = null;
    private view: DataView | null = null;
    private cpu: any = null;
    private initialized = false;
    private enabled = false;
    private enablePending = false;  // retry flag if enable() fails due to detached buffer

    // Instruction counter baseline (set when virtual time is enabled)
    private lastInsnSnapshot = 0;
    private lastWallSnapshot = 0;

    // FLS mirror used by WASM FlsGetValue hypercall. Allocation bitmap is
    // process-global (indices are), but VALUES are per-thread (fiber-local ==
    // thread-local without fibers): the UCRT stores each thread's _ptd in one
    // shared slot index — a global value table hands thread A's _ptd to thread B.
    // The page holds the CURRENT thread's values; syncThreadData swaps them.
    private readonly flsAllocatedShadow = new Uint8Array(HC_FLS_SLOT_COUNT);
    private readonly flsValuesByThread = new Map<number, Uint32Array>();
    private flsCurrentTid = 0;
    // Last capture owner published to the page. Needed because the page is a Rust static
    // that v86.restart() zeroes: without a shadow, a buffer change would silently drop a
    // held capture to 0 and the WASM handler would keep answering 0 forever.
    private captureHwndShadow = 0;

    private flsValuesFor(tid: number): Uint32Array {
        let v = this.flsValuesByThread.get(tid);
        if (!v) { v = new Uint32Array(HC_FLS_SLOT_COUNT); this.flsValuesByThread.set(tid, v); }
        return v;
    }
    // Kernel event mirror for WASM SetEvent fast path (indexed by handle slot).
    private readonly eventMirrorShadow = new Uint8Array(EVENT_TABLE_SLOTS);
    // Mutex mirror lives in guest RAM (2048 × u32); pointer stored at OFF_HC_MUTEX_MIRROR_PTR.
    private mutexMirrorAddr = 0;
    private readonly mutexMirrorShadow = new Uint32Array(EVENT_TABLE_SLOTS);
    // EAGL token-dispatch config block (guest RAM); pointer at OFF_HC_EAGL_TOKEN_CFG_PTR.
    private eaglTokenCfgAddr = 0;

    // Registration tracking — Map stores functionId → handlerId for dispatch table rebuild
    // after WASM memory buffer changes (e.g., v86.restart() zeroes HYPERCALL_PAGE statics)
    private registeredEntries = new Map<number, number>();
    // Diagnostic: while true, the write-capable string/mem handlers are forced to their JS
    // fallbacks. Must be honoured by BOTH registerFunction and the dispatch-table rebuild,
    // or a WASM-buffer change would silently re-enable them mid-run and the write trap
    // would report a clean range it never actually covered.
    private wasmStringWritersOff = false;
    /** thread handle -> slot index in the shared suspend table (packed from the front). */
    private readonly threadSuspendSlots = new Map<number, number>();

    initialize(cpu: any, hpBase: number): void {
        this.cpu = cpu;
        this.hpBase = hpBase;
        if (hpBase === 0) return;

        this.refreshViews();
        if (!this.view) return;

        // Set guest memory size for bounds-checking in WASM hypercall handlers
        const wasmExports = cpu?.wm?.exports;
        if (wasmExports?.set_guest_mem_size) {
            wasmExports.set_guest_mem_size(EMU_MEMORY_SIZE);
        }

        // Write QPF constant (1 MHz)
        this.view.setUint32(this.hpBase + OFF_HC_PERF_FREQ_LO, PERF_FREQ & 0xFFFFFFFF, true);
        this.view.setUint32(this.hpBase + OFF_HC_PERF_FREQ_HI, 0, true);

        // Initialize rand seed to 1 (matches MSVCRT default)
        this.view.setUint32(this.hpBase + OFF_HC_RAND_SEED, 1, true);

        this.view.setUint32(this.hpBase + OFF_HC_CAPTURE_HWND, this.captureHwndShadow, true);

        this.writeFlsSharedState();
        this.writeEventMirrorState();

        // Start disabled — enable after functions are registered
        this.view.setUint32(this.hpBase + OFF_HC_ENABLED, 0, true);

        this.initialized = true;
        Logger.log(LogCategory.SYSTEM,
            `[HYPERCALL] Initialized, page base=0x${hpBase.toString(16)}`);
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    /** Absolute byte offset of HYPERCALL_PAGE within WASM linear memory.
     * Guest code can reference slab fields via imm32 memory operands using
     * `getHpBase() + OFF_HC_SLAB_*`. Stable within a session; reset to 0
     * across v86.restart(). Returns 0 if not yet initialized.
     */
    getHpBase(): number {
        return this.hpBase;
    }

    private refreshViews(): void {
        const buf = this.cpu?.wasm_memory?.buffer;
        if (!buf || buf.byteLength === 0) { this.view = null; return; }
        if (buf !== this.wasmMemory) {
            this.wasmMemory = buf;
            this.view = new DataView(buf);

            // Buffer changed — WASM memory may have grown or been reset (v86.restart()).
            // HYPERCALL_PAGE is a Rust static, so restart() zeroes it.
            // Re-sync all state we've written: QPF, dispatch table, hc_enabled.
            if (this.initialized && this.hpBase !== 0) {
                this.rewriteState();
            }

            // Retry deferred enable if previous enable() failed on detached buffer
            if (this.enablePending && !this.enabled) {
                this.enablePending = false;
                this.enable();
            }
        }
    }

    /** Re-write all JS-owned state into HYPERCALL_PAGE after buffer change. */
    private rewriteState(): void {
        if (!this.view) return;

        // QPF constant
        this.view.setUint32(this.hpBase + OFF_HC_PERF_FREQ_LO, PERF_FREQ & 0xFFFFFFFF, true);
        this.view.setUint32(this.hpBase + OFF_HC_PERF_FREQ_HI, 0, true);

        // Dispatch table entries
        for (const [functionId, handlerId] of this.registeredEntries) {
            const suppressed = this.wasmStringWritersOff && WASM_WRITE_HANDLERS.has(handlerId);
            this.view.setUint8(this.hpBase + OFF_HC_DISPATCH_TABLE + functionId, suppressed ? 0 : handlerId);
        }

        // Slab control-block pointer (the slab control fields themselves live in guest RAM,
        // which survives buffer changes; only this page-resident pointer must be re-published).
        if (this.slabControlAddr !== 0) {
            this.view.setUint32(this.hpBase + OFF_HC_SLAB_CTL_PTR, this.slabControlAddr, true);
        }

        // Mutex mirror table pointer — same contract as slab: guest table survives, page pointer does not.
        if (this.mutexMirrorAddr !== 0) {
            this.view.setUint32(this.hpBase + OFF_HC_MUTEX_MIRROR_PTR, this.mutexMirrorAddr, true);
            this.writeMutexMirrorState();
        }

        // EAGL token-dispatch config pointer — same contract (guest block survives).
        if (this.eaglTokenCfgAddr !== 0) {
            this.view.setUint32(this.hpBase + OFF_HC_EAGL_TOKEN_CFG_PTR, this.eaglTokenCfgAddr, true);
        }

        // Capture owner — JS-owned, WASM never writes it, so the shadow is authoritative.
        this.view.setUint32(this.hpBase + OFF_HC_CAPTURE_HWND, this.captureHwndShadow, true);

        this.writeFlsSharedState();
        this.writeEventMirrorState(true); // preserve WASM-set signal bits across buffer-change resync

        // Re-set hc_enabled if we were enabled before buffer change
        if (this.enabled) {
            this.view.setUint32(this.hpBase + OFF_HC_ENABLED, 1, true);
            // Re-snapshot instruction counter and wall-clock — it may also have been reset
            this.lastInsnSnapshot = this.cpu?.instruction_counter?.[0] ?? 0;
            this.lastWallSnapshot = performance.now();
            Logger.log(LogCategory.SYSTEM,
                `[HYPERCALL] Re-synced state after buffer change ` +
                `(${this.registeredEntries.size} handlers, enabled=true)`);
        }
    }

    private writeFlsSharedState(): void {
        if (!this.view) return;
        const values = this.flsValuesFor(this.flsCurrentTid);
        for (let i = 0; i < HC_FLS_SLOT_COUNT; i++) {
            this.view.setUint8(this.hpBase + OFF_HC_FLS_ALLOCATED + i, this.flsAllocatedShadow[i]);
            this.view.setUint32(this.hpBase + OFF_HC_FLS_VALUES + i * 4, values[i] >>> 0, true);
        }
    }

    setFlsSlot(index: number, allocated: boolean, value: number, tid = this.flsCurrentTid): void {
        if (index < 0 || index >= HC_FLS_SLOT_COUNT) return;

        this.flsAllocatedShadow[index] = allocated ? 1 : 0;
        if (allocated) {
            this.flsValuesFor(tid)[index] = value >>> 0;
        } else {
            for (const values of this.flsValuesByThread.values()) values[index] = 0;
        }

        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.view.setUint8(this.hpBase + OFF_HC_FLS_ALLOCATED + index, this.flsAllocatedShadow[index]);
        if (tid === this.flsCurrentTid || !allocated) {
            this.view.setUint32(this.hpBase + OFF_HC_FLS_VALUES + index * 4,
                this.flsValuesFor(this.flsCurrentTid)[index] >>> 0, true);
        }
    }

    /**
     * Adopt `tid` as the thread whose FLS values the guest page holds. Normally
     * syncThreadData does this on context switch, but a single-threaded process
     * may never switch — leaving flsCurrentTid at its initial 0 so every
     * setFlsSlot(tid=1) skips the guest-page write and the WASM FlsGetValue
     * hypercall reads 0 forever (CRT then rebuilds its per-thread data on every
     * _getptd call and loses all state stored in it).
     */
    ensureFlsCurrentThread(tid: number): void {
        if (tid === this.flsCurrentTid) return;
        Logger.warn(LogCategory.SYSTEM,
            `FLS: adopting thread ${tid} as page-resident (was ${this.flsCurrentTid}, no context switch seen)`);
        this.flsCurrentTid = tid;
        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        const values = this.flsValuesFor(tid);
        for (let i = 0; i < HC_FLS_SLOT_COUNT; i++) {
            this.view.setUint32(this.hpBase + OFF_HC_FLS_VALUES + i * 4, values[i] >>> 0, true);
        }
    }

    getFlsSlot(index: number, tid = this.flsCurrentTid): number {
        if (index < 0 || index >= HC_FLS_SLOT_COUNT) return 0;
        if (!this.flsAllocatedShadow[index]) return 0;
        return this.flsValuesFor(tid)[index] >>> 0;
    }

    clearFlsSlots(): void {
        this.flsAllocatedShadow.fill(0);
        this.flsValuesByThread.clear();
        this.flsCurrentTid = 0;

        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.writeFlsSharedState();
    }

    private eventSlotForHandle(handle: number): number | null {
        return eventSlotForKernelHandle(handle);
    }

    /** Re-flush the JS-owned mirror state into WASM memory.
     *  @param preserveLiveSignals when true (buffer-change resync), keep the WASM-owned
     *  EVT_SIGNALED/EVT_PENDING_WAKE bits that handle_set_event wrote — otherwise the resync
     *  would clobber a pending fast-path signal with the stale shadow (lost wakeup). On a real
     *  reset (clearEventMirrors) pass false so everything is zeroed. */
    private writeEventMirrorState(preserveLiveSignals = false): void {
        if (!this.view) return;
        const SIG = EVT_SIGNALED | EVT_PENDING_WAKE;
        for (let slot = 0; slot < EVENT_TABLE_SLOTS; slot++) {
            const shadow = this.eventMirrorShadow[slot]!;
            let out = shadow;
            if (preserveLiveSignals) {
                const live = this.view.getUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot);
                out = (shadow & ~SIG) | (live & SIG);
            }
            this.view.setUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot, out);
        }
    }

    clearEventMirrors(): void {
        this.eventMirrorShadow.fill(0);
        this.mutexMirrorShadow.fill(0);
        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.writeEventMirrorState();
        this.writeMutexMirrorState();
        this.view.setUint32(this.hpBase + OFF_HC_EVENT_STARVATION_COUNTER, 0, true);
    }

    /** A/B kill-switch: when set BEFORE the first mutex is created, the mirror is never
     *  allocated → the HYPERCALL_PAGE pointer stays 0 → WASM handlers 80/81 see base==0 and
     *  fall through to JS, and readMutexMirrorState() returns null so JS uses its own
     *  KernelMutexObject state. Lets us bisect a mutex-mirror regression without a wasm rebuild.
     *  Set from the host console via `dbgFlag('__noMutexMirror', true)` (persisted, replayed
     *  before load — same channel as __detAudio/__noHeapSlab). */
    private mutexMirrorDisabled(): boolean {
        return (globalThis as any).__noMutexMirror === true;
    }

    /** Allocate guest-RAM mutex mirror (2048×u32) and publish pointer to HYPERCALL_PAGE. */
    ensureMutexMirrorAlloc(): number {
        if (this.mutexMirrorDisabled()) return 0;
        if (this.mutexMirrorAddr) return this.mutexMirrorAddr;
        const mem = System.getInstance().process?.memory;
        if (!mem) return 0;
        const bytes = EVENT_TABLE_SLOTS * 4;
        const addr = mem.alloc(bytes) >>> 0;
        if (!addr) return 0;
        this.mutexMirrorAddr = addr;
        this.mutexMirrorShadow.fill(0);
        this.refreshViews();
        if (this.view && this.hpBase !== 0) {
            this.view.setUint32(this.hpBase + OFF_HC_MUTEX_MIRROR_PTR, addr, true);
            this.writeMutexMirrorState();
        }
        return addr;
    }

    private writeMutexMirrorState(): void {
        if (!this.mutexMirrorAddr || !this.wasmMemory) return;
        const base = this.mutexMirrorAddr;
        const u32 = new Uint32Array(this.wasmMemory);
        for (let slot = 0; slot < EVENT_TABLE_SLOTS; slot++) {
            u32[(base >>> 2) + slot] = this.mutexMirrorShadow[slot]!;
        }
    }

    private writeMutexMirrorSlot(slot: number): void {
        if (!this.mutexMirrorAddr || !this.wasmMemory) return;
        const u32 = new Uint32Array(this.wasmMemory);
        u32[(this.mutexMirrorAddr >>> 2) + slot] = this.mutexMirrorShadow[slot]!;
    }

    private liveMutexWord(slot: number): number {
        this.refreshViews();
        if (this.mutexMirrorAddr && this.wasmMemory) {
            const u32 = new Uint32Array(this.wasmMemory);
            return u32[(this.mutexMirrorAddr >>> 2) + slot]!;
        }
        return this.mutexMirrorShadow[slot] ?? 0;
    }

    registerMutexMirror(handle: number, ownerThreadId: number | null, recursion: number): void {
        if (this.mutexMirrorDisabled()) return;
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;
        if (!mutexMirrorValuesInRange(ownerThreadId, recursion)) {
            this.unregisterMutexMirror(handle);
            return;
        }
        this.ensureMutexMirrorAlloc();
        const word = packMutexMirrorWord(ownerThreadId ?? 0, recursion, true, false);
        this.mutexMirrorShadow[slot] = word;
        this.writeMutexMirrorSlot(slot);
    }

    unregisterMutexMirror(handle: number): void {
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;
        this.mutexMirrorShadow[slot] = 0;
        this.writeMutexMirrorSlot(slot);
    }

    writeMutexMirror(
        handle: number,
        ownerThreadId: number | null,
        recursion: number,
        hasWaiters?: boolean,
        abandoned?: boolean,
    ): void {
        if (this.mutexMirrorDisabled()) return;
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;
        if (!mutexMirrorValuesInRange(ownerThreadId, recursion)) {
            this.unregisterMutexMirror(handle);
            return;
        }
        this.ensureMutexMirrorAlloc();
        const prev = unpackMutexMirrorWord(this.liveMutexWord(slot));
        const word = packMutexMirrorWord(
            ownerThreadId ?? 0,
            recursion,
            true,
            hasWaiters ?? prev.hasWaiters,
            abandoned ?? prev.abandoned,
        );
        this.mutexMirrorShadow[slot] = word;
        this.writeMutexMirrorSlot(slot);
    }

    setMutexMirrorHasWaiters(handle: number, hasWaiters: boolean): void {
        if (this.mutexMirrorDisabled()) return;
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;
        const prev = unpackMutexMirrorWord(this.liveMutexWord(slot));
        if (!prev.valid) return;
        const word = packMutexMirrorWord(prev.owner ?? 0, prev.recursion, true, hasWaiters, prev.abandoned);
        this.mutexMirrorShadow[slot] = word;
        this.writeMutexMirrorSlot(slot);
    }

    readMutexMirrorState(handle: number): {
        owner: number | null;
        recursion: number;
        hasWaiters: boolean;
        abandoned: boolean;
    } | null {
        if (this.mutexMirrorDisabled()) return null;
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return null;
        const u = unpackMutexMirrorWord(this.liveMutexWord(slot));
        if (!u.valid) return null;
        return { owner: u.owner, recursion: u.recursion, hasWaiters: u.hasWaiters, abandoned: u.abandoned };
    }

    registerEventMirror(handle: number, manualReset: boolean, initialState: boolean): void {
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;

        let flags = EVT_VALID;
        if (manualReset) flags |= EVT_MANUAL;
        if (initialState) {
            flags |= EVT_SIGNALED;
            if (manualReset) flags |= EVT_PENDING_WAKE;
        }
        this.eventMirrorShadow[slot] = flags;

        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.view.setUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot, flags);
    }

    unregisterEventMirror(handle: number): void {
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;

        this.eventMirrorShadow[slot] = 0;
        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.view.setUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot, 0);
    }

    /** Live mirror flags for a slot. The WASM SetEvent fast-path (handle_set_event) writes
     *  EVT_SIGNALED/EVT_PENDING_WAKE straight into WASM memory, which the JS-only shadow never
     *  sees — so the WASM byte is authoritative. Every read-modify-write of the mirror must base
     *  on this (not eventMirrorShadow), or the JS write clobbers the WASM-set signal → lost
     *  wakeup → deadlock. Falls back to the shadow only before the WASM view exists. */
    private liveEventFlags(slot: number): number {
        this.refreshViews();
        if (this.view && this.hpBase !== 0) {
            return this.view.getUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot);
        }
        return this.eventMirrorShadow[slot] ?? 0;
    }

    writeEventMirrorSignaled(handle: number, signaled: boolean, manualReset: boolean): void {
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;

        let flags = this.liveEventFlags(slot);
        if ((flags & EVT_VALID) === 0) return;

        if (signaled) {
            flags |= EVT_SIGNALED;
            if (manualReset) flags |= EVT_PENDING_WAKE;
        } else {
            flags &= ~(EVT_SIGNALED | EVT_PENDING_WAKE);
        }
        this.eventMirrorShadow[slot] = flags;

        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.view.setUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot, flags);
    }

    clearEventMirrorPendingWake(handle: number): void {
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;

        let flags = this.liveEventFlags(slot);
        if ((flags & EVT_VALID) === 0) return;

        flags &= ~EVT_PENDING_WAKE;
        this.eventMirrorShadow[slot] = flags;

        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.view.setUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot, flags);
    }

    setEventMirrorHasWaiters(handle: number, hasWaiters: boolean): void {
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return;

        let flags = this.liveEventFlags(slot);
        if ((flags & EVT_VALID) === 0) return;

        if (hasWaiters) flags |= EVT_HAS_WAITERS;
        else flags &= ~EVT_HAS_WAITERS;
        this.eventMirrorShadow[slot] = flags;

        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.view.setUint8(this.hpBase + OFF_HC_EVENT_TABLE + slot, flags);
    }

    readEventMirrorState(handle: number): { signaled: boolean; manualReset: boolean; pendingWake: boolean } | null {
        const slot = this.eventSlotForHandle(handle);
        if (slot === null) return null;

        // Read the LIVE WASM byte, not the shadow — the SetEvent fast-path signals here.
        const flags = this.liveEventFlags(slot);
        if ((flags & EVT_VALID) === 0) return null;

        return {
            signaled: (flags & EVT_SIGNALED) !== 0,
            manualReset: (flags & EVT_MANUAL) !== 0,
            pendingWake: (flags & EVT_PENDING_WAKE) !== 0,
        };
    }

    /**
     * Set the starvation limit for WASM SetEvent handler.
     * Every N consecutive fast-path calls, one falls through to JS.
     */
    setEventStarvationLimit(limit: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_EVENT_STARVATION_LIMIT, limit >>> 0, true);
    }

    /**
     * Register a function for WASM handling.
     * Called after stubs are generated so functionId is known.
     */
    registerFunction(dllName: string, functionName: string, functionId: number): void {
        if (!this.initialized || !this.view) return;
        if (functionId <= 0 || functionId >= 4096) return;

        const key = `${dllName.toLowerCase()}.${functionName.toLowerCase()}`;
        const handlerId = HANDLER_MAP[key];
        if (!handlerId) return;

        this.refreshViews();
        if (!this.view) return;

        // Write handler_id into dispatch_table[functionId]
        const offset = this.hpBase + OFF_HC_DISPATCH_TABLE + functionId;
        // Use setUint8 since dispatch table entries are single bytes
        const suppressed = this.wasmStringWritersOff && WASM_WRITE_HANDLERS.has(handlerId);
        this.view.setUint8(offset, suppressed ? 0 : handlerId);
        this.registeredEntries.set(functionId, handlerId);

        Logger.verbose(LogCategory.SYSTEM,
            `[HYPERCALL] Registered ${key} (funcId=${functionId}) → handler ${handlerId}`);
    }

    /**
     * Bind a raw functionId → handler_id (no name lookup). Used by Guarded
     * Inner-Loop HLE: the hle-lib patcher hands the
     * converter's JMP-stub functionId here with the inner-loop handler band id
     * (128..=255), so the guest OUT is served entirely in WASM. If the WASM
     * handler returns false (guard miss), dispatch falls through to the JS
     * thunk registered under the same functionId — the shadow-validated kernel.
     * Idempotent; survives dispatch-table rebuild via registeredEntries.
     */
    registerRawHandler(functionId: number, handlerId: number): void {
        if (functionId <= 0 || functionId >= 4096) {
            Logger.warn(LogCategory.SYSTEM,
                `[HYPERCALL] registerRawHandler: functionId ${functionId} out of dispatch-table range`);
            return;
        }
        if (handlerId <= 0 || handlerId > 255) {
            Logger.warn(LogCategory.SYSTEM,
                `[HYPERCALL] registerRawHandler: handlerId ${handlerId} not a u8`);
            return;
        }
        this.registeredEntries.set(functionId, handlerId);
        this.refreshViews();
        if (this.view) {
            this.view.setUint8(this.hpBase + OFF_HC_DISPATCH_TABLE + functionId, handlerId);
        }
        Logger.log(LogCategory.SYSTEM,
            `[HYPERCALL] Registered raw funcId=${functionId} → handler ${handlerId} (inner-loop HLE)`);
    }

    /**
     * Route the WASM string/memory handlers that WRITE guest memory back to their JS
     * fallbacks (`on = false`), or restore them (`on = true`). Live — no reload needed.
     *
     * Diagnostic seam, not a perf knob. A Rust hypercall writes guest memory through a
     * raw pointer: it raises no #PF (so MemWriteTrap cannot see it) and never touches
     * `Mem` (so the JS write trap cannot see it either). Forcing these six to JS is what
     * makes a memory-corruption hunt able to observe them at all, and doubles as the A/B
     * that convicts or clears the WASM implementations. The heap-slab handlers are NOT in
     * this set — `__noHeapSlab` owns that switch.
     */
    setWasmStringWritersEnabled(on: boolean): { enabled: boolean; affected: number[] } {
        const writers = WASM_WRITE_HANDLERS;
        this.wasmStringWritersOff = !on;
        this.refreshViews();
        const affected: number[] = [];
        for (const [functionId, handlerId] of this.registeredEntries) {
            if (!writers.has(handlerId)) continue;
            affected.push(functionId);
            if (this.view) {
                this.view.setUint8(this.hpBase + OFF_HC_DISPATCH_TABLE + functionId, on ? handlerId : 0);
            }
        }
        Logger.log(LogCategory.SYSTEM,
            `[HYPERCALL] WASM string/mem WRITERS ${on ? "enabled" : "DISABLED (JS fallback)"} ` +
            `for ${affected.length} functionIds`);
        return { enabled: on, affected };
    }

    /** True while the write-capable string/mem handlers are forced to JS. */
    areWasmStringWritersOff(): boolean {
        return this.wasmStringWritersOff;
    }

    /** Remove a raw dispatch-table binding (inner-loop hook unpatch). */
    unregisterRawHandler(functionId: number): void {
        if (functionId <= 0 || functionId >= 4096) return;
        this.registeredEntries.delete(functionId);
        this.refreshViews();
        if (this.view) {
            this.view.setUint8(this.hpBase + OFF_HC_DISPATCH_TABLE + functionId, 0);
        }
    }

    /**
     * Publish (or clear, addr=0) the EAGL token-dispatch config block pointer
     * for inner-loop handler 132 (hypercall.rs handle_eagl_token_dispatch).
     * The block itself lives in guest RAM (survives buffer changes); only this
     * page-resident pointer needs re-publishing, same contract as the slab /
     * mutex-mirror pointers.
     */
    setEaglTokenConfigPtr(addr: number): void {
        this.eaglTokenCfgAddr = addr >>> 0;
        this.refreshViews();
        if (this.view && this.hpBase !== 0) {
            this.view.setUint32(this.hpBase + OFF_HC_EAGL_TOKEN_CFG_PTR, this.eaglTokenCfgAddr, true);
        }
    }

    /** Enable WASM hypercall dispatch and activate instruction-based virtual time. */
    enable(): void {
        if (!this.initialized) return;

        // Arm instruction-based virtual time as soon as dispatch is requested — BEFORE any early
        // return (detached buffer, or already-enabled). The old code only called this inside the
        // `if(!this.enabled)` block AFTER both early returns, so a deferred-enable retry (where
        // rewriteState() had already flipped this.enabled true off the WASM hc_enabled flag) hit the
        // `this.enabled && wasmEnabled===1` early return and SILENTLY left virtual time off
        // (observed: vtActive=false). Then GetTickCount/QPC/timeGetTime — and now RDTSC, which reads
        // the SAME HYPERCALL_PAGE base — all fell back to raw performance.now(). enableVirtualTime()
        // is idempotent (guards on virtualTimeActive), so calling it unconditionally up-front is safe.
        TimeService.getInstance().enableVirtualTime();

        this.refreshViews();
        if (!this.view) {
            Logger.warn(LogCategory.SYSTEM,
                `[HYPERCALL] enable() deferred: WASM memory buffer unavailable (detached?). ` +
                `${this.registeredEntries.size} handlers registered but not yet activated.`);
            this.enablePending = true;
            return;
        }

        // Check if already enabled both in JS and WASM — skip to avoid
        // resetting virtual time baseline on redundant calls
        const wasmEnabled = this.view.getUint32(this.hpBase + OFF_HC_ENABLED, true);
        if (this.enabled && wasmEnabled === 1) return;

        this.view.setUint32(this.hpBase + OFF_HC_ENABLED, 1, true);

        // Only snapshot the instruction-counter baseline on the FIRST enable (must seed once).
        // Re-enable after buffer change (rewriteState) already re-snapshots.
        if (!this.enabled) {
            this.lastInsnSnapshot = this.cpu?.instruction_counter?.[0] ?? 0;
            this.lastWallSnapshot = performance.now();
        }
        this.enabled = true;

        // Dump dispatch table entries for string/memory handlers (51+) for diagnostics
        const activeHandlers: string[] = [];
        for (let fid = 0; fid < 4096; fid++) {
            const hid = this.view.getUint8(this.hpBase + OFF_HC_DISPATCH_TABLE + fid);
            if (hid >= 51) {
                activeHandlers.push(`${fid}→${hid}`);
            }
        }
        Logger.log(LogCategory.SYSTEM,
            `[HYPERCALL] Enabled with ${this.registeredEntries.size} registered functions, virtual time active. ` +
            `String/mem handlers (${activeHandlers.length}): [${activeHandlers.join(', ')}]`);
    }

    /** Disable WASM hypercall dispatch (JS fallback takes over) */
    disable(): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_ENABLED, 0, true);
        this.enabled = false;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** Reset dispatch table and registration state. Call on system reset. */
    resetDispatchTable(): void {
        this.refreshViews();
        if (this.view && this.hpBase !== 0) {
            for (let i = 0; i < 4096; i++) {
                this.view.setUint8(this.hpBase + OFF_HC_DISPATCH_TABLE + i, 0);
            }
            this.view.setUint32(this.hpBase + OFF_HC_ENABLED, 0, true);
        }
        this.registeredEntries.clear();
        this.enabled = false;
        this.enablePending = false;
        this.clearFlsSlots();
    }

    /** Reset instruction baseline after pause/resume to prevent stale delta. */
    resetInsnBaseline(): void {
        this.lastInsnSnapshot = this.cpu?.instruction_counter?.[0] ?? 0;
        this.lastWallSnapshot = performance.now();
    }

    /**
     * Update time-related data in shared page.
     * Called before each main_loop() tick via tick_hooks_before.
     *
     * Virtual time model: game-visible time advances proportionally to
     * instructions executed (insnDelta / TARGET_INSN_PER_MS), with gentle
     * drift correction toward wall-clock for audio sync. A per-tick cap
     * (MAX_VIRTUAL_DELTA_MS) prevents large dt that causes physics tunneling
     * (e.g. car skipping through checkpoint triggers in Re-Volt).
     */
    updateTimeData(): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;

        const timeService = TimeService.getInstance();

        // --- Compute instruction-based virtual delta ---
        const insnNow = this.cpu?.instruction_counter?.[0] ?? 0;
        const insnDelta = (insnNow - this.lastInsnSnapshot) >>> 0;
        let virtualDeltaMs = insnDelta / TARGET_INSN_PER_MS;

        // Safety cap: prevent physics tunneling even in worst case
        virtualDeltaMs = Math.min(virtualDeltaMs, MAX_VIRTUAL_DELTA_MS);

        // Hard clamp: virtual time must not lead wall clock by more than MAX_AHEAD_MS.
        // v86 in a Web Worker can tick faster than 1ms, causing instruction-based time
        // to accumulate faster than wall clock. This prevents runaway speedup.
        const wallNow = performance.now();
        const currentVirtual = timeService.nowMs();
        const maxAllowed = wallNow + MAX_AHEAD_MS - currentVirtual;
        if (maxAllowed < virtualDeltaMs) {
            virtualDeltaMs = Math.max(0, maxAllowed);
        }

        // Catch-up rate limiter: when virtual time is behind wall-clock (e.g. after
        // heavy sync thunks like video decode), limit advancement to ~10% above
        // wall-clock rate. Without this, instruction-based delta runs at up to 4ms/tick
        // while wall-clock advances ~1ms/tick, creating 4× speedup (death spiral:
        // fast-forwarded video → more decodes → more deficit → more catch-up).
        if (currentVirtual < wallNow) {
            const wallDelta = wallNow - this.lastWallSnapshot;
            if (wallDelta > 0) {
                const maxCatchupDelta = wallDelta * 1.1;
                virtualDeltaMs = Math.min(virtualDeltaMs, maxCatchupDelta);
            }
        }

        // Advance virtual time
        timeService.advanceVirtualTime(virtualDeltaMs);

        // --- Write to HYPERCALL_PAGE ---
        const nowMs = timeService.nowMs();
        const nowMicros = Math.floor(nowMs * 1000);

        // Tick count (truncated to 32-bit ms)
        this.view.setUint32(this.hpBase + OFF_HC_TICK_COUNT, nowMs >>> 0, true);

        // Performance counter = microseconds
        this.view.setUint32(this.hpBase + OFF_HC_PERF_COUNTER_LO, nowMicros & 0xFFFFFFFF, true);
        this.view.setUint32(this.hpBase + OFF_HC_PERF_COUNTER_HI,
            Math.floor(nowMicros / 0x100000000), true);

        // WASM interpolation: constant MIPS since time is instruction-based.
        // WASM formula: interpolated = base + (insn_now - insn_at_update) / mips
        // (This drives QPC/GetTickCount AND RDTSC — v86 read_tsc derives the TSC from this
        // same interpolated base ×4294.967296 ticks/µs, so their ratio is constant and guest
        // cross-clock calibration (UE1 GSecondsPerCycle) is exact by construction.)
        this.view.setUint32(this.hpBase + OFF_HC_INSN_AT_TIME_UPDATE, insnNow >>> 0, true);
        this.view.setUint32(this.hpBase + OFF_HC_MIPS_ESTIMATE, TARGET_MIPS_PER_US, true);

        this.lastInsnSnapshot = insnNow;
        this.lastWallSnapshot = wallNow;
    }

    /**
     * Refresh tick count / QPC in the hypercall page after a sync thunk has already
     * called advanceVirtualTime().  The WASM GetTickCount hypercall reads directly
     * from OFF_HC_TICK_COUNT — it never calls JS — so the page must be updated here
     * for the change to be visible within the same tick (e.g. AVI spin-wait loops).
     * Also resets OFF_HC_INSN_AT_TIME_UPDATE so WASM interpolation starts fresh.
     * Does NOT update lastInsnSnapshot / lastWallSnapshot — updateTimeData() handles those.
     */
    refreshTimeAfterThunk(cpu: any): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;

        const nowMs = TimeService.getInstance().nowMs();
        const nowMicros = Math.floor(nowMs * 1000);
        const insnNow = (cpu?.instruction_counter?.[0] ?? 0) >>> 0;

        this.view.setUint32(this.hpBase + OFF_HC_TICK_COUNT, nowMs >>> 0, true);
        this.view.setUint32(this.hpBase + OFF_HC_PERF_COUNTER_LO, nowMicros & 0xFFFFFFFF, true);
        this.view.setUint32(this.hpBase + OFF_HC_PERF_COUNTER_HI,
            Math.floor(nowMicros / 0x100000000), true);
        this.view.setUint32(this.hpBase + OFF_HC_INSN_AT_TIME_UPDATE, insnNow, true);
    }

    /**
     * Sync per-thread data on context switch.
     * Called from scheduler.performSwitch().
     */
    syncThreadData(threadId: number, lastError: number, tebBase: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;

        this.view.setUint32(this.hpBase + OFF_HC_LAST_ERROR, lastError >>> 0, true);
        this.view.setUint32(this.hpBase + OFF_HC_TEB_BASE, tebBase >>> 0, true);
        this.view.setUint32(this.hpBase + OFF_HC_CURRENT_THREAD_ID, threadId >>> 0, true);

        // FLS values are per-thread — swap the page-resident table (read by the
        // WASM FlsGetValue fast path) to the incoming thread's set.
        if (threadId !== this.flsCurrentTid) {
            this.flsCurrentTid = threadId;
            const values = this.flsValuesFor(threadId);
            for (let i = 0; i < HC_FLS_SLOT_COUNT; i++) {
                this.view.setUint32(this.hpBase + OFF_HC_FLS_VALUES + i * 4, values[i] >>> 0, true);
            }
        }
    }

    /** Read lastError back from WASM (WASM may have modified via SetLastError) */
    readLastError(): number {
        if (!this.initialized || !this.view) return 0;
        this.refreshViews();
        if (!this.view) return 0;
        return this.view.getUint32(this.hpBase + OFF_HC_LAST_ERROR, true);
    }

    /**
     * Push a JS-side SetLastError into the WASM hypercall page so a subsequent
     * GetLastError hypercall (served from the page, no context switch in between)
     * observes the fresh value. Without this, a JS thunk that fails and calls
     * scheduler.setLastError() leaves the page stale until the next context
     * switch, and the guest's immediate GetLastError reads the old code.
     */
    writeLastError(value: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_LAST_ERROR, value >>> 0, true);
    }

    /** Get total WASM-handled call count (diagnostic) */
    getCallCount(): number {
        if (!this.initialized || !this.view) return 0;
        this.refreshViews();
        if (!this.view) return 0;
        return this.view.getUint32(this.hpBase + OFF_HC_CALL_COUNT, true);
    }

    getRegisteredCount(): number {
        return this.registeredEntries.size;
    }

    // =========================================================================
    // Heap arena slab management
    // =========================================================================

    /** Point the JS/inline-stub slab control block at a guest-RAM address. When set,
     * all slab field reads/writes target guest RAM (so the inline x86 stub, which can
     * only address guest RAM, shares one physical control block with JS). Must be a
     * zero-initialised THUNK_DATA block ≥ (OFF_HC_SLAB_FREELIST-OFF_HC_SLAB_BASE)+36 B. */
    setSlabControlAddr(guestAddr: number): void {
        this.slabControlAddr = guestAddr >>> 0;
        // Publish the guest address into the page so the WASM heap handler can find the
        // control block too (it can't otherwise know the guest-RAM location). Re-published
        // on buffer change via rewriteState().
        this.refreshViews();
        if (this.view && this.hpBase !== 0) {
            this.view.setUint32(this.hpBase + OFF_HC_SLAB_CTL_PTR, this.slabControlAddr, true);
        }
    }

    /**
     * WASM-buffer offset B such that `B + OFF_HC_SLAB_*` addresses the slab control
     * block. In guest-RAM mode the block lives at guest address `slabControlAddr`
     * (laid out at the SAME relative offsets as the page fields), which maps to WASM
     * buffer offset `mem8.byteOffset + slabControlAddr`; rebasing by OFF_HC_SLAB_BASE
     * lets every existing `B + OFF_HC_SLAB_*` access work unchanged. Legacy mode
     * (slabControlAddr===0, or guest mem base unavailable) falls back to the page.
     */
    private slabBlockBase(): number {
        if (this.slabControlAddr !== 0) {
            const memBase = this.cpu?.mem8?.byteOffset;
            if (typeof memBase === 'number') {
                return memBase + this.slabControlAddr - OFF_HC_SLAB_BASE;
            }
        }
        return this.hpBase;
    }

    /** Initialize a heap slab for HeapAlloc/HeapFree (inline stub + JS share the block). */
    initializeHeapSlab(slabBase: number, slabEnd: number): void {
        if (!this.view) return;
        this.refreshViews();
        if (!this.view) return;
        const B = this.slabBlockBase();
        this.view.setUint32(B + OFF_HC_SLAB_BASE, slabBase, true);
        this.view.setUint32(B + OFF_HC_SLAB_END, slabEnd, true);
        this.view.setUint32(B + OFF_HC_SLAB_BUMP, slabBase, true);
        this.view.setUint32(B + OFF_HC_SLAB_ALLOC_COUNT, 0, true);
        this.view.setUint32(B + OFF_HC_SLAB_FREE_COUNT, 0, true);
        this.view.setUint32(B + OFF_HC_SLAB_FALLBACK_COUNT, 0, true);
        for (let i = 0; i < 9; i++) {
            this.view.setUint32(B + OFF_HC_SLAB_FREELIST + i * 4, 0, true);
        }
        const gen = this.view.getUint32(B + OFF_HC_SLAB_GENERATION, true);
        this.view.setUint32(B + OFF_HC_SLAB_GENERATION, gen + 1, true);
    }

    /**
     * Read the 9 per-bin free-list head pointers (bins 16..4096) from the slab
     * control block. Each head is a freed block's user pointer; the free list is
     * linked through the freed block's first data word (see handle_heap_free in
     * hypercall.rs). Used by a faithful HeapWalk to mark slab blocks busy vs free.
     */
    getSlabFreelistHeads(): number[] {
        if (!this.view) return [];
        this.refreshViews();
        if (!this.view) return [];
        const heads: number[] = [];
        const B = this.slabBlockBase();
        for (let i = 0; i < 9; i++) {
            heads.push(this.view.getUint32(B + OFF_HC_SLAB_FREELIST + i * 4, true) >>> 0);
        }
        return heads;
    }

    /** Reset slab on process cleanup — disables WASM heap dispatch. */
    resetHeapSlab(): void {
        if (!this.view) return;
        this.refreshViews();
        if (!this.view) return;
        const B = this.slabBlockBase();
        this.view.setUint32(B + OFF_HC_SLAB_BASE, 0, true);
        this.view.setUint32(B + OFF_HC_SLAB_END, 0, true);
        this.view.setUint32(B + OFF_HC_SLAB_BUMP, 0, true);
        for (let i = 0; i < 9; i++) {
            this.view.setUint32(B + OFF_HC_SLAB_FREELIST + i * 4, 0, true);
        }
    }

    /** Read slab statistics for diagnostics. */
    getSlabStats(): { allocs: number; frees: number; fallbacks: number; used: number; capacity: number } {
        if (!this.view) return { allocs: 0, frees: 0, fallbacks: 0, used: 0, capacity: 0 };
        this.refreshViews();
        if (!this.view) return { allocs: 0, frees: 0, fallbacks: 0, used: 0, capacity: 0 };
        const B = this.slabBlockBase();
        const base = this.view.getUint32(B + OFF_HC_SLAB_BASE, true);
        const end = this.view.getUint32(B + OFF_HC_SLAB_END, true);
        const bump = this.view.getUint32(B + OFF_HC_SLAB_BUMP, true);
        return {
            allocs: this.view.getUint32(B + OFF_HC_SLAB_ALLOC_COUNT, true),
            frees: this.view.getUint32(B + OFF_HC_SLAB_FREE_COUNT, true),
            fallbacks: this.view.getUint32(B + OFF_HC_SLAB_FALLBACK_COUNT, true),
            used: bump - base,
            capacity: end - base,
        };
    }

    /**
     * Update cursor position in shared page.
     * Called before each main_loop() tick.
     */
    updateCursorData(x: number, y: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setInt32(this.hpBase + OFF_HC_CURSOR_X, x, true);
        this.view.setInt32(this.hpBase + OFF_HC_CURSOR_Y, y, true);
    }

    /**
     * Publish the mouse-capture owner (GetCapture) into the shared page.
     *
     * Event-driven, NOT per tick: capture changes on SetCapture/ReleaseCapture/window
     * destroy, while games poll GetCapture every frame. Must be called from the single
     * owner of the capture slot (WindowManager) so no path can leave the page stale —
     * a stale value here is not a slow answer, it is a WRONG one the guest cannot detect.
     */
    updateCaptureHwnd(hwnd: number): void {
        this.captureHwndShadow = hwnd >>> 0;
        if (!this.initialized) return;
        this.refreshViews();
        if (!this.view || this.hpBase === 0) return;
        this.view.setUint32(this.hpBase + OFF_HC_CAPTURE_HWND, this.captureHwndShadow, true);
    }

    /**
     * Update main window offset in shared page.
     * Called when window position changes.
     */
    updateWindowData(x: number, y: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setInt32(this.hpBase + OFF_HC_WINDOW_X, x, true);
        this.view.setInt32(this.hpBase + OFF_HC_WINDOW_Y, y, true);
    }

    /**
     * Update the message queue flag in shared page.
     * WASM PeekMessage handler reads this to short-circuit when queue is empty.
     */
    updateMessageQueueFlag(hasMessages: boolean): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_MSG_QUEUE_FLAG, hasMessages ? 1 : 0, true);
    }

    /**
     * Set the starvation limit for WASM PeekMessage handler.
     * Every N consecutive WASM-handled calls, one falls through to JS
     * so that onThunkComplete() / scheduler hooks still run.
     */
    setPeekMessageStarvationLimit(limit: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_PEEK_STARVATION_LIMIT, limit >>> 0, true);
    }

    /**
     * Set the starvation limit for WASM Sleep(0) handler.
     * Every N consecutive Sleep(0) calls with runnable peers, one falls through
     * to JS for actual context switch. Others are no-ops in WASM.
     */
    setSleepStarvationLimit(limit: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_SLEEP_STARVATION_LIMIT, limit >>> 0, true);
    }

    /**
     * Publish one thread's suspend count for the WASM ResumeThread handler.
     *
     * The handler answers only "this thread is NOT suspended, so the resume is a no-op", so the
     * table must never claim 0 for a thread that IS suspended — every count change publishes,
     * and a terminated thread is removed (its handle can come back on a new thread). A handle
     * that is absent, or a full table, simply means the JS scheduler answers as it always did.
     */
    setThreadSuspendCount(handle: number, suspendCount: number): void {
        if (!this.initialized || !this.view) return;
        const h = handle >>> 0;
        if (h === 0) return;
        let slot = this.threadSuspendSlots.get(h);
        if (slot === undefined) {
            if (this.threadSuspendSlots.size >= HC_THREAD_SUSPEND_SLOTS) return;
            slot = this.threadSuspendSlots.size;
            this.threadSuspendSlots.set(h, slot);
        }
        this.refreshViews();
        if (!this.view) return;
        const base = this.hpBase + OFF_HC_THREAD_SUSPEND + slot * 8;
        this.view.setUint32(base, h, true);
        this.view.setUint32(base + 4, suspendCount >>> 0, true);
    }

    /** Drop a thread from the table (termination). Slots stay packed from the front: the
     *  handler stops scanning at the first empty one. */
    forgetThreadSuspendCount(handle: number): void {
        if (!this.initialized || !this.view) return;
        const h = handle >>> 0;
        const slot = this.threadSuspendSlots.get(h);
        if (slot === undefined) return;
        this.threadSuspendSlots.delete(h);
        this.refreshViews();
        if (!this.view) return;
        const lastSlot = this.threadSuspendSlots.size; // index of the now-surplus tail entry
        if (slot !== lastSlot) {
            // Move the tail entry into the hole so the scan never sees a gap.
            const from = this.hpBase + OFF_HC_THREAD_SUSPEND + lastSlot * 8;
            const to = this.hpBase + OFF_HC_THREAD_SUSPEND + slot * 8;
            const movedHandle = this.view.getUint32(from, true);
            this.view.setUint32(to, movedHandle, true);
            this.view.setUint32(to + 4, this.view.getUint32(from + 4, true), true);
            if (movedHandle !== 0) this.threadSuspendSlots.set(movedHandle >>> 0, slot);
        }
        const tail = this.hpBase + OFF_HC_THREAD_SUSPEND + lastSlot * 8;
        this.view.setUint32(tail, 0, true);
        this.view.setUint32(tail + 4, 0, true);
    }

    /** Process reset — the next run's threads are not this one's. */
    resetThreadSuspendTable(): void {
        this.threadSuspendSlots.clear();
        if (!this.initialized) return;
        this.refreshViews();
        if (!this.view) return;
        for (let i = 0; i < HC_THREAD_SUSPEND_SLOTS; i++) {
            const off = this.hpBase + OFF_HC_THREAD_SUSPEND + i * 8;
            this.view.setUint32(off, 0, true);
            this.view.setUint32(off + 4, 0, true);
        }
    }

    /**
     * Update the "has runnable peers" flag in shared page.
     * WASM Sleep(0) handler reads this: if 0, Sleep(0) is a no-op (stay in WASM).
     * Called by scheduler on every thread state transition.
     */
    updateRunnablePeersFlag(hasRunnablePeers: boolean): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_HAS_RUNNABLE_PEERS, hasRunnablePeers ? 1 : 0, true);
    }

    /**
     * Read message queue flag from shared page.
     * 1 means WASM-side fast PeekMessage path sees queue as non-empty.
     */
    readMessageQueueFlag(): number {
        if (!this.initialized || !this.view) return 0;
        this.refreshViews();
        if (!this.view) return 0;
        return this.view.getUint32(this.hpBase + OFF_HC_MSG_QUEUE_FLAG, true);
    }

    /**
     * Read PeekMessage starvation counter from shared page.
     */
    readPeekStarvationCounter(): number {
        if (!this.initialized || !this.view) return 0;
        this.refreshViews();
        if (!this.view) return 0;
        return this.view.getUint32(this.hpBase + OFF_HC_PEEK_STARVATION_COUNTER, true);
    }

    /**
     * Read Sleep(0) starvation counter from shared page.
     */
    readSleepStarvationCounter(): number {
        if (!this.initialized || !this.view) return 0;
        this.refreshViews();
        if (!this.view) return 0;
        return this.view.getUint32(this.hpBase + OFF_HC_SLEEP_STARVATION_COUNTER, true);
    }

    /**
     * Read runnable peers flag from shared page.
     * 1 means scheduler has peer threads eligible to run.
     */
    readRunnablePeersFlag(): number {
        if (!this.initialized || !this.view) return 0;
        this.refreshViews();
        if (!this.view) return 0;
        return this.view.getUint32(this.hpBase + OFF_HC_HAS_RUNNABLE_PEERS, true);
    }

    /**
     * Update rand seed in shared page.
     * Called by srand() to sync JS seed to WASM.
     */
    updateRandSeed(seed: number): void {
        if (!this.initialized || !this.view) return;
        this.refreshViews();
        if (!this.view) return;
        this.view.setUint32(this.hpBase + OFF_HC_RAND_SEED, seed >>> 0, true);
    }

    /**
     * Read rand seed from shared page (for diagnostics).
     */
    readRandSeed(): number {
        if (!this.initialized || !this.view) return 0;
        this.refreshViews();
        if (!this.view) return 0;
        return this.view.getUint32(this.hpBase + OFF_HC_RAND_SEED, true);
    }

    /**
     * Per-handler_id accounting from HYPERCALL_PAGE — the answer to "which hypercall",
     * which the single wrapping hc_call_count cannot give.
     *
     * `served` = calls the WASM handler completed; `fellBack` = calls it declined
     * (returned false), which then cost a full JS thunk round-trip. A fast path with a
     * high fallback ratio is not a fast path — that ratio is the number worth reading.
     * Counters saturate rather than wrap, so `saturated: true` is reported explicitly
     * instead of a lapped value passing for a small one.
     *
     * Cumulative since page init (and reset by v86.restart(), which zeroes the static) —
     * take two readings and subtract for a windowed measurement.
     */
    getHandlerReport(): Array<{
        handlerId: number;
        names: string[];
        served: number;
        fellBack: number;
        saturated: boolean;
    }> {
        const result: Array<{
            handlerId: number; names: string[]; served: number; fellBack: number; saturated: boolean;
        }> = [];
        if (!this.initialized) return result;
        this.refreshViews();
        if (!this.view || this.hpBase === 0) return result;

        for (let id = 0; id < HC_HANDLER_SLOTS; id++) {
            const served = this.view.getUint32(this.hpBase + OFF_HC_HANDLER_CALLS + id * 4, true);
            const fellBack = this.view.getUint32(this.hpBase + OFF_HC_HANDLER_FALLBACKS + id * 4, true);
            if (served === 0 && fellBack === 0) continue;
            result.push({
                handlerId: id,
                names: namesForHandlerId(id),
                served,
                fellBack,
                saturated: served === 0xFFFFFFFF || fellBack === 0xFFFFFFFF,
            });
        }
        result.sort((a, b) => (b.served + b.fellBack) - (a.served + a.fellBack));
        return result;
    }
}

/** handler_id → the WinAPI/CRT names bound to it (several names share one handler). */
let handlerIdNames: Map<number, string[]> | null = null;
function namesForHandlerId(id: number): string[] {
    if (handlerIdNames === null) {
        handlerIdNames = new Map();
        for (const [key, handlerId] of Object.entries(HANDLER_MAP)) {
            const list = handlerIdNames.get(handlerId);
            if (list) list.push(key);
            else handlerIdNames.set(handlerId, [key]);
        }
    }
    return handlerIdNames.get(id) ?? [];
}

export const hypercallDataManager = new HypercallDataManager();
