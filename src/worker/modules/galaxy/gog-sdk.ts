/**
 * GOG Galaxy SDK entry points.
 *
 * A GOG build ships `Galaxy.dll` in its app directory — the SAME basename as Unreal's
 * Galaxy audio DLL that the rest of this module emulates. Two unrelated libraries, one
 * import-table name, so one HLE module has to answer for both; the export sets are
 * disjoint, which is what keeps them apart.
 *
 * What we recreate is a Galaxy SDK that constructs locally and does nothing online: the
 * factory hands back real interfaces whose methods are no-ops. Returning NULL instead is
 * what a real Galaxy.dll never does past `CreateInstance` — its getters THROW rather than
 * answer NULL, so callers dereference the result unchecked, and a NULL there is an access
 * violation rather than a graceful decline.
 *
 * THE VTABLE LAYOUT IS THE CONTRACT — see d3dx9/effects.ts for the same rule. A guest
 * calls slot N with the arity the real interface declares; an invented order answers with
 * a method of a different arg count and the RET N mismatch walks the caller's ESP off its
 * own frame, faulting in code with no connection to Galaxy. These are plain C++ interfaces,
 * NOT COM: MSVC compiles them __thiscall, so `this` rides in ECX and is NOT pushed. The
 * counts below are PUSHED arguments only — do not copy the COM tables, whose counts
 * include a pushed `this`.
 *
 * PROVENANCE — every layout below is transcribed from the shipped binaries, not from a
 * header or from memory:
 *   - `GalaxyFactory::CreateInstance` (Galaxy.dll, 0x1002b990) returns the object built at
 *     0x10011600, whose constructor stores vftable 0x102e97a0. Its MSVC RTTI complete-object
 *     locator names it `.?AVGalaxyTranslator@galaxy@@`, the concrete `galaxy::api::IGalaxy`.
 *     That vftable has exactly 14 entries; each slot's PUSHED-ARG COUNT is the `RET imm16`
 *     of the function it points at (all agree across every return site in the body).
 *   - Sub-interface identity comes from the field each getter returns: the translator's
 *     constructors store `UserTranslator` at +0x2c, `FriendsTranslator` at +0x30,
 *     `MatchmakingTranslator` at +0x34, `NetworkingTranslator` at +0x38 and +0x3c, and
 *     `StatsTranslator` at +0x40 (call sites 0x10013b20/b5c/b95/bd0/c0e/c41), and the six
 *     getters read those fields in that order.
 *   - `GetErrorManager` (0x1002bcc0) constructs a 12-byte object with vftable 0x102eb6c0 =
 *     `.?AVTranslatorErrorManager@galaxy@@`, 2 slots. `ResetInstance` (0x1002bd30) calls
 *     IGalaxy slot 0 with a pushed 1 — MSVC's scalar deleting destructor, hence arity 1.
 *   - `IListenerRegistrar` is not in Galaxy.dll: slots 10/11 call a function pointer
 *     resolved out of GalaxyPeer.dll. Its implementation there is
 *     `gog::GenericListenerRegistrar<galaxy::api::IGalaxyListener,0,0x16>` (vftable
 *     0x1055048c), 3 slots — destructor, then Register/Unregister with two pushed args each.
 *   - Cross-checked against what the title actually calls (w2.exe, base 0x400000): slot 1
 *     with three pushed args (0x441dc6), slot 4 then IUser slot 3 with none — "GOG: Signing
 *     In..." (0x442a2b), slot 10 then IListenerRegistrar slot 1 with two (twelve sites,
 *     0x443da6..0x444e5d), slot 12 with none in the per-frame pump (0x441e90).
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { InterfaceDescriptor, ModuleDescriptor } from '../../api/types';
import { createComObject } from '../d3d9/shared-state';

/** Mangled names as the SDK's import library spells them (MSVC, 32-bit). */
export const GOG_GALAXY_EXPORTS = {
    createInstance: '?CreateInstance@GalaxyFactory@api@galaxy@@SAPAVIGalaxy@23@XZ',
    getInstance: '?GetInstance@GalaxyFactory@api@galaxy@@SAPAVIGalaxy@23@XZ',
    getErrorManager: '?GetErrorManager@GalaxyFactory@api@galaxy@@SAPAVIErrorManager@23@XZ',
    resetInstance: '?ResetInstance@GalaxyFactory@api@galaxy@@SAXXZ',
} as const;

function method(name: string, argCount: number) {
    return {
        name,
        params: Array.from({ length: argCount }, (_, i) => ({ name: `arg${i}`, type: 'u32' as const })),
        returnType: 'u32' as const,
        callingConvention: 'stdcall' as const,
    };
}

/**
 * A sub-interface we only know STRUCTURALLY: slot count and per-slot pushed-arg count,
 * read off the shipped vtable. Slot 0 is MSVC's scalar deleting destructor everywhere.
 * The names are positional because nothing in the binaries names them; the arity is what
 * keeps the guest's stack intact, and that is measured.
 */
function iface(name: string, argCounts: readonly number[]): InterfaceDescriptor {
    return {
        name,
        methods: argCounts.map((n, i) =>
            method(i === 0 ? 'Destructor' : `Slot${i}`, n)),
    };
}

/** galaxy::api::IUser — UserTranslator vftable 0x102eb250, 13 slots. */
const IUser = iface('IUser', [1, 0, 1, 0, 3, 2, 0, 1, 2, 0, 5, 1, 0]);
/** galaxy::api::IFriends — FriendsTranslator vftable 0x102e9380, 9 slots. */
const IFriends = iface('IFriends', [1, 0, 2, 3, 2, 2, 1, 0, 1]);
/** galaxy::api::IMatchmaking — MatchmakingTranslator vftable 0x102e9bd4, 26 slots. */
const IMatchmaking = iface('IMatchmaking', [
    1, 2, 0, 3, 3, 2, 2, 2, 2, 2, 2, 4, 2, 3, 4, 2, 7, 3, 5, 4, 4, 9, 3, 3, 4, 6,
]);
/** galaxy::api::INetworking — NetworkingTranslator vftable 0x102ea668, 7 slots. */
const INetworking = iface('INetworking', [1, 6, 5, 2, 5, 1, 2]);
/** galaxy::api::IStats — StatsTranslator vftable 0x102ea944, 24 slots. */
const IStats = iface('IStats', [
    1, 2, 3, 3, 2, 2, 4, 5, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 3, 5, 3, 4, 3,
]);
/**
 * galaxy::api::IListenerRegistrar — GalaxyPeer.dll vftable 0x1055048c, 3 slots.
 * Slot 1 Register(ListenerType, IGalaxyListener*) / slot 2 Unregister, two pushed args
 * each. This is the ONE sub-interface the title calls into, twelve times at start-up.
 */
const IListenerRegistrar = iface('IListenerRegistrar', [1, 2, 2]);

/**
 * IGalaxy slots 11 has no identified interface — it reads a second GalaxyPeer function
 * pointer (+0x50) that this build never exercises. It still has to answer with an OBJECT,
 * not 0, for the same reason every other getter does, so it gets a deliberately minimal
 * one: a destructor plus a few zero-arg slots. Anything we invent past that would be a
 * guess with a stack cost, which is exactly what this file exists to stop.
 */
const IGalaxyUnknown = iface('IGalaxyUnknown', [1, 0, 0, 0, 0, 0, 0, 0]);

/**
 * galaxy::api::IErrorManager — TranslatorErrorManager vftable 0x102eb6c0, 2 slots.
 * Slot 1 GetError() -> const IError* — non-NULL means "the last call failed".
 */
const IErrorManager: InterfaceDescriptor = {
    name: 'IErrorManager',
    methods: [method('Destructor', 1), method('GetError', 0)],
};

/**
 * galaxy::api::IError — TranslatorRuntimeError vftable 0x102e934c, 5 slots (the
 * UnauthorizedAccess/InvalidArgument/InvalidState translators all have the same shape).
 * Slots 1..3 are the documented GetType/GetName/GetMsg, all zero-arg; slot 4 takes two
 * pushed args and is unidentified.
 */
const IError: InterfaceDescriptor = {
    name: 'IError',
    methods: [
        method('Destructor', 1),
        method('GetType', 0),
        method('GetName', 0),
        method('GetMsg', 0),
        method('Slot4', 2),
    ],
};

/**
 * galaxy::api::IGalaxy — GalaxyTranslator vftable 0x102e97a0, 14 slots, in this order.
 * Slots 4..11 are getters that return a sub-interface pointer; 12 is the per-frame pump;
 * 13 forwards to the error manager. Slot 8 is a SECOND NetworkingTranslator (a larger
 * allocation than slot 7's), so it is a distinct networking interface of the same shape —
 * named positionally rather than guessed at.
 */
const IGalaxy: InterfaceDescriptor = {
    name: 'IGalaxy',
    methods: [
        method('Destructor', 1),
        method('Init', 3),
        method('InitOverload', 4),
        method('Shutdown', 0),
        method('GetUser', 0),
        method('GetFriends', 0),
        method('GetMatchmaking', 0),
        method('GetNetworking', 0),
        method('GetNetworking2', 0),
        method('GetStats', 0),
        method('GetListenerRegistrar', 0),
        method('GetUnknown11', 0),
        method('ProcessData', 0),
        method('GetError', 0),
    ],
};

/** IGalaxy slot name -> the interface whose object that getter must hand back. */
const IGALAXY_GETTERS: ReadonlyArray<readonly [string, string]> = [
    ['GetUser', 'IUser'],
    ['GetFriends', 'IFriends'],
    ['GetMatchmaking', 'IMatchmaking'],
    ['GetNetworking', 'INetworking'],
    ['GetNetworking2', 'INetworking'],
    ['GetStats', 'IStats'],
    ['GetListenerRegistrar', 'IListenerRegistrar'],
    ['GetUnknown11', 'IGalaxyUnknown'],
];

const INTERFACES: readonly InterfaceDescriptor[] = [
    IGalaxy, IErrorManager, IError,
    IUser, IFriends, IMatchmaking, INetworking, IStats, IListenerRegistrar, IGalaxyUnknown,
];

const gogGalaxyDescriptor: ModuleDescriptor = {
    name: 'galaxy',
    functions: [],
    interfaces: [...INTERFACES],
};

/** GalaxyError::GALAXY_ERROR / UNAUTHORIZED_ACCESS — "no client", the offline branch. */
const GALAXY_ERROR_TYPE = 1;

let vtables: Record<string, VTableInfo> | null = null;
let galaxyInstance = 0;
/** One object per interface name — the SDK's own getters are singletons too. */
const singletons = new Map<string, number>();
/** Status of the LAST SDK call — see IErrorManager::GetError below. */
let lastCallFailed = false;

export function resetGogGalaxyState(): void {
    vtables = null;
    galaxyInstance = 0;
    singletons.clear();
    lastCallFailed = false;
}

export function createGogGalaxyExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const objectFor = (name: string): number => {
        const existing = singletons.get(name);
        if (existing) return existing;
        if (!vtables) vtables = createVTablesFromDescriptor(process, gogGalaxyDescriptor);
        const vtable = vtables[name]?.address ?? 0;
        const obj = vtable ? createComObject(vtable) : 0;
        if (obj) singletons.set(name, obj);
        return obj;
    };

    exports[GOG_GALAXY_EXPORTS.createInstance] = () =>
        (galaxyInstance = objectFor('IGalaxy'));
    // GetInstance is a plain read of the SDK's static (Galaxy.dll 0x1002bd10: `mov eax,
    // [globals]; ret`), so it answers NULL before CreateInstance and after ResetInstance —
    // which is what the one call site that checks (`if (GetInstance()) ProcessData()`) is
    // testing for. The unchecked sites all run after a successful CreateInstance.
    exports[GOG_GALAXY_EXPORTS.getInstance] = () => galaxyInstance;
    exports[GOG_GALAXY_EXPORTS.getErrorManager] = () => objectFor('IErrorManager');
    // ResetInstance drops the SDK's singleton (it destroys it and NULLs the static). It is
    // itself an SDK call and it succeeds, which clears the error the failed call left
    // behind; without that the standing error outlives the reset and every later frame
    // reports a failure belonging to a call the title already handled.
    exports[GOG_GALAXY_EXPORTS.resetInstance] = () => {
        galaxyInstance = 0;
        lastCallFailed = false;
        return 0;
    };

    // Default for every interface method: a no-op that SUCCEEDS. A sub-interface method
    // answers 0 — these return void, bool, an id or a string, and there is nothing
    // truthful to invent for them; only the arity above is load-bearing.
    for (const descriptor of INTERFACES) {
        for (const m of descriptor.methods) {
            exports[`${descriptor.name}_${m.name}`] = () => { lastCallFailed = false; return 0; };
        }
    }

    // …except an IGalaxy getter, which must hand back the sub-interface object. The real
    // ones never answer NULL: they throw when the SDK is not initialised, so a caller
    // dereferences the result without checking.
    for (const [slot, target] of IGALAXY_GETTERS) {
        exports[`IGalaxy_${slot}`] = () => { lastCallFailed = false; return objectFor(target); };
    }

    // Init SUCCEEDS. The SDK initialises locally — the Galaxy client is needed for the
    // online features, not to construct the interfaces — so reporting a failure here sends
    // a title down a teardown path it did not have to take: WWP answers a failed Init with
    // ResetInstance, and the very next subsystem then dereferences GetInstance() without
    // checking. `lastCallFailed` stays as the error model's one moving part, for an
    // operation we later find genuinely cannot work offline.
    exports['IGalaxy_Init'] = () => { lastCallFailed = false; return 0; };

    // `GetError` reports the LAST call, not a standing condition — the SDK clears it on
    // every successful call, and a title's per-frame pump asks right after a local no-op
    // that did succeed. Answering "error" unconditionally makes every such frame log a
    // failure that did not happen. IGalaxy slot 13 is the same query (Galaxy.dll 0x10012150
    // tail-calls GetErrorManager()->GetError()).
    const getError = () => (lastCallFailed ? objectFor('IError') : 0);
    exports['IErrorManager_GetError'] = getError;
    exports['IGalaxy_GetError'] = getError;
    exports['IError_GetType'] = () => GALAXY_ERROR_TYPE;

    return exports;
}
