/**
 * IDirect3DTexture9::AddRef, answered in guest code.
 *
 * WHY. `apiCensus` over an NFSU race: 108 937 WASM→JS crossings per second, 40.4 % of them
 * this one method, whose JS body is `map.get(ptr) + 1`. The crossing — not the work — is the
 * cost, and the drain-vs-rest split measures the removable half at ~0.97 us of a 3.85 us call,
 * ~4.3 % of wall. With the count of record already in the guest COM block
 * (`D3D9_COM_REFCOUNT_OFFSET`), the whole method is `inc [this+4]; mov eax,[this+4]; ret 4`.
 *
 * PRECONDITION, enforced here rather than assumed: the guest word must BE the count of record
 * (`__d3d9GuestRefcount`). With the JS Map authoritative the stub's increments would be
 * invisible to the JS side, the count would run low, and an object would be destroyed while
 * the guest still holds references. Registration refuses, loudly, if the flag is off — and
 * once it installs it PINS the guest store so a later flag flip cannot hand authority back to
 * a mirror that missed increments.
 *
 * STALE POINTERS. The trampoline only touches `this` when its vptr still equals the live
 * IDirect3DTexture9 vtable published here. A block recycled into another interface fails that
 * test; a poisoned one (`__comPoisonReleased`) carries the released-COM trap's vtable and
 * fails it too. Two cases remain and neither is a new hazard: a block recycled into ANOTHER
 * Texture9 is incremented by the JS handler as well (its registry is address-keyed), and a
 * freed block not yet recycled takes a write that allocateComObject's zero-fill erases before
 * anyone can read it. Release is NOT stubbed — see the note at the bottom of this file.
 *
 * Flags (BOOT-TIME: patching a stub has no unpatch path):
 *   __d3d9GuestAddRefStub — install the live stub.
 *   __d3d9AddRefStubVerify — install the NON-MUTATING oracle instead: guest code predicts the
 *     value the live stub would return, and the JS handler still runs and compares.
 */

import { Logger, LogCategory } from '../../core/logger';
import { D3D9_COM_REFCOUNT_OFFSET, pinGuestRefcountStore } from './com-refs';

const IFACE = 'IDirect3DTexture9';
const FUNC = `${IFACE}_AddRef`;

interface AddRefStubFlags {
    /** Answer Texture9::AddRef in guest code (default off). */
    __d3d9GuestAddRefStub?: boolean;
    /** Differential oracle: predict in guest code, still trap, compare (default off). */
    __d3d9AddRefStubVerify?: boolean;
    /** The guest block must already be the count of record. */
    __d3d9GuestRefcount?: boolean;
}
const flags = globalThis as AddRefStubFlags;

type IncRefDispatcher = {
    registerGuestIncRefStub?: (dll: string, fn: string, spec: {
        fieldOffset: number; popBytes: number; verify?: boolean;
    }) => void;
    setIncRefExpectedVtable?: (dll: string, fn: string, addr: number) => void;
    incRefStubStatus?: (dll: string, fn: string) => { installed: boolean; verify: boolean; vtable: number };
    consumeIncRefPrediction?: (dll: string, fn: string) => { value: number; valid: boolean } | null;
};

let boundDispatcher: IncRefDispatcher | null = null;
let mode: 'off' | 'live' | 'verify' = 'off';
let pendingVtable = 0;

let checked = 0;
let mismatch = 0;
let unpredicted = 0;
let firstMismatch: string | null = null;

/**
 * Install the stub (or its oracle) for Texture9::AddRef. Call once, at D3D9 fast-path
 * registration; a no-op unless a flag asks for it.
 */
export function registerGuestAddRefStub(dispatcher: unknown): void {
    const want = !!flags.__d3d9GuestAddRefStub;
    const verify = !!flags.__d3d9AddRefStubVerify;
    if (!want && !verify) return;

    const d = dispatcher as IncRefDispatcher;
    if (typeof d?.registerGuestIncRefStub !== 'function') {
        Logger.warn(LogCategory.D3D9, 'guest AddRef stub: dispatcher has no registerGuestIncRefStub');
        return;
    }
    if (!flags.__d3d9GuestRefcount) {
        // Refusing beats installing: with the Map authoritative the stub's increments are
        // invisible to JS and the object dies under the guest's feet.
        Logger.error(LogCategory.D3D9,
            'guest AddRef stub REFUSED: __d3d9GuestAddRefStub needs __d3d9GuestRefcount ' +
            '(the guest block must be the count of record, not a mirror)');
        return;
    }

    boundDispatcher = d;
    mode = verify ? 'verify' : 'live';
    d.registerGuestIncRefStub('d3d9', FUNC, {
        fieldOffset: D3D9_COM_REFCOUNT_OFFSET,
        popBytes: 4,          // stdcall AddRef(this)
        verify,
    });
    if (mode === 'live') pinGuestRefcountStore();
    if (pendingVtable) d.setIncRefExpectedVtable?.('d3d9', FUNC, pendingVtable);
    Logger.log(LogCategory.D3D9,
        `guest AddRef stub installed for ${FUNC} (${mode}), refcount at +${D3D9_COM_REFCOUNT_OFFSET}`);
}

/**
 * Publish the live IDirect3DTexture9 vtable — the stub's proof that `this` is still one of
 * ours. Pass 0 when the vtables are torn down; the stub then traps for everything, which is
 * the pre-stub behaviour and always safe.
 */
export function publishTexture9Vtable(vtableAddr: number): void {
    pendingVtable = vtableAddr >>> 0;
    boundDispatcher?.setIncRefExpectedVtable?.('d3d9', FUNC, pendingVtable);
}

/** Is the oracle (not the live stub) the thing installed? */
export function guestAddRefOracleActive(): boolean {
    return mode === 'verify';
}

/**
 * Compare the guest prediction against what the JS handler actually answered for the SAME
 * call. What this can catch is exactly what can go wrong: an emitted body that reads the
 * wrong stack slot or the wrong field, a `this` the registry does not know (the stale-pointer
 * case), and a guest word that has drifted from the count JS would compute.
 *
 * A call the trampoline did not predict (null `this`, vtable gate closed, or a route that
 * reached this handler without passing through the trampoline at all) is counted SEPARATELY as
 * `unpredicted` — the stub abstaining, not a disagreement. The prediction is consumed on read
 * so the second of those cannot borrow the previous call's verdict.
 *
 * OPEN QUESTION: in-race runs report 7 178 882/0 and 3 432 248/1, the single disagreement being
 * `guest=5 js=4` — the guest one ahead. Unexplained at ~1 in 3 M, and the reason this stays
 * default-OFF.
 */
export function noteGuestAddRefOracle(actual: number): void {
    if (mode !== 'verify') return;
    const p = boundDispatcher?.consumeIncRefPrediction?.('d3d9', FUNC);
    if (!p) return;
    if (!p.valid) { unpredicted++; return; }
    checked++;
    if ((p.value >>> 0) !== (actual >>> 0)) {
        mismatch++;
        if (firstMismatch === null) firstMismatch = `guest=${p.value >>> 0} js=${actual >>> 0}`;
    }
}

/**
 * Oracle readout. `checked: 0` says the oracle never ran — never that it passed.
 */
export function d3d9GuestAddRefStats(reset = false): {
    mode: string;
    installed: boolean;
    vtablePublished: string;
    checked: number;
    mismatch: number;
    unpredicted: number;
    firstMismatch: string | null;
    verdict: string;
} {
    const status = boundDispatcher?.incRefStubStatus?.('d3d9', FUNC);
    const out = {
        mode,
        installed: !!status?.installed,
        vtablePublished: `0x${(status?.vtable ?? pendingVtable).toString(16)}`,
        checked,
        mismatch,
        unpredicted,
        firstMismatch,
        verdict: mode !== 'verify'
            ? (mode === 'live' ? 'live stub: no oracle running' : 'stub not installed')
            : (checked === 0
                ? 'oracle did not run'
                : (mismatch === 0 ? 'agree' : 'DISAGREE')),
    };
    if (reset) { checked = 0; mismatch = 0; unpredicted = 0; firstMismatch = null; }
    return out;
}

/** Test hook: drop all installation state (no runtime path unregisters a patched stub). */
export function resetGuestAddRefStubForTests(): void {
    boundDispatcher = null;
    mode = 'off';
    pendingVtable = 0;
    checked = 0; mismatch = 0; unpredicted = 0; firstMismatch = null;
}

/** Release is the other half of this pair and lives in guest-release-stub.ts. */
