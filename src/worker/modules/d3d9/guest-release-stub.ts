/**
 * IDirect3DTexture9::Release, answered in guest code — the other half of the AddRef pair.
 *
 * WHY. The same `apiCensus` that put AddRef at 40.4 % of every WASM→JS crossing puts Release at
 * the identical 40.4 %; the drain-vs-rest split measures the REMOVABLE half of it at 4.27 % of
 * wall. Its JS body is `map.get(ptr) - 1`.
 *
 * WHAT MAKES IT HARDER THAN ADDREF, and how the trampoline answers it. The 1→0 transition runs
 * the finalizer and the disposer (`com-refs.releaseComRef`) and must reach JS. So the emitted
 * body TESTS BEFORE IT DECREMENTS: `cmp [this+4],1; jbe .out`. At 1 (and at a bogus 0) nothing
 * is written and the ordinary OUT trap runs, so JS sees exactly the state it sees today. The
 * other ordering — decrement, then decide to trap — would have to tell JS "the guest already
 * did it", a contract nothing can verify at the trap and that any other route into the handler
 * would turn into a double decrement.
 *
 * `__d3d9StreamRing` IS NOT AFFECTED, and the reason is that the two are different stubs. That
 * feature is safe because IDirect3D*Buffer9_Release is an OUT trap and handlePortWrite drains
 * the ring before dispatching it; stub patching is per (dll, function NAME), so patching
 * `IDirect3DTexture9_Release` leaves every Buffer9 Release exactly as it was. The same drain
 * argument covers the textures this stub DOES cover: SetTexture is ring-deferred, and a texture
 * only ever dies at a trap (the zero transition above), which drains the ring first. The
 * exclusion is nevertheless ENFORCED rather than described — registration refuses a buffer
 * interface while the ring is on.
 *
 * PRECONDITION, enforced not assumed: the guest word must BE the count of record
 * (the default), or the stub's decrements are invisible to JS and the count runs
 * high — an object that never dies. Installing PINS the guest store.
 *
 * WHAT THE VTABLE GATE GUARANTEES — AND WHAT IT DOES NOT. It guarantees the target still
 * carries the live Texture9 vtable and a count of at least 2. It does NOT guarantee the pointer
 * still identifies the object the caller believes it does. Three stale cases:
 *   - recycled into another interface, or poisoned (`__comPoisonReleased`): vptr differs, traps.
 *   - freed and not yet recycled: JS zeroes the guest word when it drops an object
 *     (com-refs dropCount), so the count test declines and the call traps without writing.
 *   - recycled into ANOTHER Texture9: the gate passes and a LIVE object is decremented. This is
 *     the dangerous one — and it is not new. The JS handler's registry is address-keyed, so a
 *     stale Release decrements the new occupant there too, and takes it to zero itself. The stub
 *     reproduces today's behaviour rather than adding to it, which is why poisoning is not made
 *     a precondition here; `__comPoisonReleased` is what would actually close the case, for both
 *     paths at once.
 *
 * Flags (BOOT-TIME: patching a stub has no unpatch path):
 *   __d3d9NoGuestComStubs — opt OUT (the live stub is the default).
 *   __d3d9ReleaseStubVerify — install the NON-MUTATING oracle instead.
 */

import { Logger, LogCategory } from '../../core/logger';
import { D3D9_COM_REFCOUNT_OFFSET, pinGuestRefcountStore } from './com-refs';

const DEFAULT_IFACE = 'IDirect3DTexture9';

/**
 * Interfaces whose Release is the drain barrier `__d3d9StreamRing` rides on. A no-trap Release
 * for one of these would let a bound buffer be destroyed while a SetStreamSource/SetIndices
 * naming it is still sitting in the ring.
 */
const RING_BARRIER_INTERFACES = new Set(['IDirect3DVertexBuffer9', 'IDirect3DIndexBuffer9']);

interface ReleaseStubFlags {
    /** Opt OUT: keep answering Texture9::Release in JS (default: guest code answers above zero). */
    __d3d9NoGuestComStubs?: boolean;
    /** Differential oracle: predict in guest code, still trap, compare (default off). */
    __d3d9ReleaseStubVerify?: boolean;
    /** Opt out of the guest block being the count of record — also disables this stub. */
    __d3d9MirrorRefcount?: boolean;
    /** SetStreamSource/SetIndices deferred onto the WBUF ring. */
    __d3d9StreamRing?: boolean;
}
const flags = globalThis as ReleaseStubFlags;

type DecRefDispatcher = {
    registerGuestIncRefStub?: (dll: string, fn: string, spec: {
        fieldOffset: number; popBytes: number; verify?: boolean; kind?: 'inc' | 'dec';
    }) => void;
    setIncRefExpectedVtable?: (dll: string, fn: string, addr: number) => void;
    incRefStubStatus?: (dll: string, fn: string) => { installed: boolean; verify: boolean; vtable: number };
    consumeIncRefPrediction?: (dll: string, fn: string) => { value: number; valid: boolean; code: number } | null;
};

let boundDispatcher: DecRefDispatcher | null = null;
let mode: 'off' | 'live' | 'verify' = 'off';
let installedIface = DEFAULT_IFACE;
let pendingVtable = 0;

let checked = 0;
let mismatch = 0;
let unpredicted = 0;
/** Predictions the oracle's OWN trap invalidated — see noteGuestReleaseOracle. */
let displaced = 0;
let firstDisplaced: string | null = null;
/** Calls the stub deliberately handed to JS — the 1→0 transition and the bogus-count guard. */
let zeroChecked = 0;
let zeroMismatch = 0;
let firstMismatch: string | null = null;

const funcName = (): string => `${installedIface}_Release`;

/**
 * Install the stub (or its oracle) for `iface`::Release. Call once, at D3D9 fast-path
 * registration; a no-op unless a flag asks for it.
 *
 * `iface` is a parameter and not a constant because the refusal below has to be reachable:
 * the ring-barrier rule is a property of the interface, not of this call site.
 */
export function registerGuestReleaseStub(dispatcher: unknown, iface: string = DEFAULT_IFACE): void {
    const verify = !!flags.__d3d9ReleaseStubVerify;
    const want = !verify && !flags.__d3d9NoGuestComStubs;
    if (!want && !verify) return;

    const d = dispatcher as DecRefDispatcher;
    if (typeof d?.registerGuestIncRefStub !== 'function') {
        Logger.warn(LogCategory.D3D9, 'guest Release stub: dispatcher has no registerGuestIncRefStub');
        return;
    }
    if (flags.__d3d9MirrorRefcount) {
        // Refusing beats installing: with the Map authoritative the stub's decrements are
        // invisible to JS, so the count never reaches zero and the object never dies.
        Logger.error(LogCategory.D3D9,
            'guest Release stub REFUSED: __d3d9MirrorRefcount puts the count back in the JS Map, ' +
            'so the stub would decrement a word nobody reads');
        return;
    }
    if (RING_BARRIER_INTERFACES.has(iface) && flags.__d3d9StreamRing) {
        Logger.error(LogCategory.D3D9,
            `guest Release stub REFUSED for ${iface}: __d3d9StreamRing defers SetStreamSource/` +
            'SetIndices and relies on this Release being the OUT trap that drains the ring first');
        return;
    }

    boundDispatcher = d;
    installedIface = iface;
    mode = verify ? 'verify' : 'live';
    d.registerGuestIncRefStub('d3d9', funcName(), {
        fieldOffset: D3D9_COM_REFCOUNT_OFFSET,
        popBytes: 4,          // stdcall Release(this)
        verify,
        kind: 'dec',
    });
    if (mode === 'live') pinGuestRefcountStore();
    if (pendingVtable) d.setIncRefExpectedVtable?.('d3d9', funcName(), pendingVtable);
    Logger.log(LogCategory.D3D9,
        `guest Release stub installed for ${funcName()} (${mode}), refcount at +${D3D9_COM_REFCOUNT_OFFSET}`);
}

/**
 * Publish the live IDirect3DTexture9 vtable — the stub's proof that `this` is still one of
 * ours. Pass 0 when the vtables are torn down; the stub then traps for everything, which is
 * the pre-stub behaviour and always safe.
 */
export function publishTexture9ReleaseVtable(vtableAddr: number): void {
    pendingVtable = vtableAddr >>> 0;
    if (installedIface !== DEFAULT_IFACE) return;
    boundDispatcher?.setIncRefExpectedVtable?.('d3d9', funcName(), pendingVtable);
}

/** Is the oracle (not the live stub) the thing installed? */
export function guestReleaseOracleActive(): boolean {
    return mode === 'verify';
}

/**
 * Compare the guest prediction against what the JS handler actually answered for the SAME call.
 *
 * Two kinds of prediction, and BOTH are checked, because the interesting failure is on the
 * second: code 1 is "guest code would have answered `value`", compared directly; code 2 is
 * "guest code would have DECLINED, having read `value` as the count" — the 1→0 transition —
 * where the check is that the count the trampoline read predicts what JS computed
 * (`value - 1`, floored at 0). A stub whose gate or field offset is wrong shows up there as a
 * count that does not explain the answer, which is exactly the read that would otherwise
 * destroy a live object.
 *
 * A call the trampoline did not predict (null `this`, vtable gate closed, or a route that
 * reached this handler without passing through the trampoline at all) is counted SEPARATELY as
 * `unpredicted` — the stub abstaining, not a disagreement.
 */
export function noteGuestReleaseOracle(actual: number, wordBeforeJs: number): void {
    if (mode !== 'verify') return;
    const p = boundDispatcher?.consumeIncRefPrediction?.('d3d9', funcName());
    if (!p) return;
    const answer = actual >>> 0;
    const word = wordBeforeJs | 0;   // < 0 = no informative word; never excuse on it
    // The oracle traps where the live stub would not, and handlePortWrite drains the
    // WBUF ring before dispatching — a drain handler can add or drop a reference on
    // THIS object in between. `word` is the count as JS found it; when JS's answer is
    // explained by `word` but the guest's prediction is not, the count moved under the
    // oracle rather than the two tiers disagreeing. Anything else is a real mismatch.
    const displacedBy = (predictedFrom: number): boolean =>
        word > 0 && predictedFrom !== word && answer === word - 1;
    if (p.code === 2) {
        const count = p.value >>> 0;
        const expected = count > 0 ? count - 1 : 0;
        checked++;
        zeroChecked++;
        if (expected !== answer) {
            if (displacedBy(count)) {
                displaced++;
                if (firstDisplaced === null) firstDisplaced = `zero-path guestCount=${count} jsWord=${word}`;
                return;
            }
            mismatch++;
            zeroMismatch++;
            if (firstMismatch === null) firstMismatch = `zero-path guestCount=${count} js=${answer} jsWord=${word}`;
        }
        return;
    }
    if (p.code !== 1) { unpredicted++; return; }
    checked++;
    const guess = p.value >>> 0;
    if (guess !== answer) {
        if (displacedBy(guess + 1)) {
            displaced++;
            if (firstDisplaced === null) firstDisplaced = `guest=${guess} js=${answer} jsWord=${word}`;
            return;
        }
        mismatch++;
        if (firstMismatch === null) firstMismatch = `guest=${guess} js=${answer} jsWord=${word}`;
    }
}

/**
 * The two facts the verdict must never merge: whether the tiers disagreed, and whether
 * the 1->0 transition — the only place a wrong answer destroys a live object — was ever
 * exercised. Displacement is appended to both, never allowed to replace either.
 */
function releaseVerdict(): string {
    if (mode !== 'verify') return mode === 'live' ? 'live stub: no oracle running' : 'stub not installed';
    if (checked === 0) return 'oracle did not run';
    if (mismatch > 0) return 'DISAGREE';
    const base = zeroChecked === 0 ? 'agree, but the 1->0 transition never ran' : 'agree';
    return displaced === 0
        ? base
        : `${base} — ${displaced} prediction(s) displaced by the oracle own drain`;
}

/**
 * Oracle readout. `checked: 0` says the oracle never ran — never that it passed, and neither
 * does agreement that never covered a destruction: `zeroChecked: 0` gets its own verdict.
 */
export function d3d9GuestReleaseStats(reset = false): {
    mode: string;
    installed: boolean;
    iface: string;
    vtablePublished: string;
    checked: number;
    mismatch: number;
    unpredicted: number;
    displaced: number;
    zeroChecked: number;
    zeroMismatch: number;
    firstMismatch: string | null;
    firstDisplaced: string | null;
    verdict: string;
} {
    const status = boundDispatcher?.incRefStubStatus?.('d3d9', funcName());
    const out = {
        mode,
        installed: !!status?.installed,
        iface: installedIface,
        vtablePublished: `0x${(status?.vtable ?? pendingVtable).toString(16)}`,
        checked,
        mismatch,
        unpredicted,
        displaced,
        zeroChecked,
        zeroMismatch,
        firstMismatch,
        firstDisplaced,
        verdict: releaseVerdict(),
    };
    if (reset) {
        checked = 0; mismatch = 0; unpredicted = 0; displaced = 0;
        zeroChecked = 0; zeroMismatch = 0; firstMismatch = null; firstDisplaced = null;
    }
    return out;
}

/** Test hook: drop all installation state (no runtime path unregisters a patched stub). */
export function resetGuestReleaseStubForTests(): void {
    boundDispatcher = null;
    mode = 'off';
    installedIface = DEFAULT_IFACE;
    pendingVtable = 0;
    checked = 0; mismatch = 0; unpredicted = 0; displaced = 0;
    zeroChecked = 0; zeroMismatch = 0; firstMismatch = null; firstDisplaced = null;
}
