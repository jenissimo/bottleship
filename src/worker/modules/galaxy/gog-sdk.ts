/**
 * GOG Galaxy SDK entry points.
 *
 * A GOG build ships `Galaxy.dll` in its app directory — the SAME basename as Unreal's
 * Galaxy audio DLL that the rest of this module emulates. Two unrelated libraries, one
 * import-table name, so one HLE module has to answer for both; the export sets are
 * disjoint, which is what keeps them apart.
 *
 * What we recreate is a Galaxy SDK that constructs locally and does nothing online: it
 * hands back real interfaces whose methods are no-ops. Returning NULL instead is what a
 * real Galaxy.dll does not do once the SDK is up — the factory generation's getters THROW
 * rather than answer NULL — so callers dereference the result unchecked, and a NULL there
 * is an access violation rather than a graceful decline.
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
 *
 * TWO SDK GENERATIONS, TWO SETS OF LAYOUTS. A later SDK drops `GalaxyFactory` for
 * namespace-level free functions (`galaxy::api::Init/User/Apps/Stats/Utils/…`). Its
 * interfaces are NOT the factory generation's with methods appended — `IUser` agrees for
 * three slots and then diverges — so the layouts below are kept apart rather than shared.
 * Provenance for that generation (Galaxy.dll of The Bard's Tale ARPG, GOG build
 * 1207659164, 32-bit, image base 0x10000000):
 *   - Each getter is `mov eax,[singleton]; test eax,eax; je -> xor eax,eax; add eax,0x34`
 *     (`User` 0x100bfe50, `Stats` 0x100be8f0, `Utils` 0x100bfe70, `Apps` 0x100bd030), so
 *     the interface is a base subobject at +0x34 of a facade object, and it answers NULL
 *     while that singleton is absent — unlike the factory generation's throwing getters.
 *   - The singletons are constructed at 0x100bd8a0.. and stored to 0x10a9c868 (User),
 *     0x10a9c87c (Stats), 0x10a9c880 (Utils), 0x10a9c888 (Apps); their constructors store
 *     the +0x34 vftable directly (0x100e1c2f, 0x1010814f, 0x10113f7f, 0x1011e3f6), which
 *     is what ties each singleton to the RTTI-named class whose table is transcribed
 *     below. Teardown (0x100bd148..) calls slot 0 with a pushed 1 and NULLs the global,
 *     so after `Shutdown` the getters answer NULL again.
 *   - `Init` (0x100bd4e0) reads its by-reference argument at +0x00, +0x0c, +0x10, +0x14,
 *     +0x18 and +0x1c (word) — the extent validated at our boundary.
 *   - Per-slot PUSHED-ARG COUNT is the `RET imm16`, measured with `re vtable`, which
 *     follows control flow: MSVC lays the `__unwind$`/`__catch$` funclets inside the same
 *     address range and a funclet ends in a bare `ret`, so a linear read of these bodies
 *     answers `0` for methods that clean up arguments.
 *   - Cross-checked against what the title actually calls (The Bard's Tale.exe, base
 *     0x400000): IUser slot 7 with two pushed args (0x597f58, 0x597fb3, 0x598023,
 *     0x735113), IApps slot 3 with two (0x735180), IStats slots 8 and 9 with one each
 *     (0x73555d), IUtils slot 6 with none, tail-jumped straight after the per-frame
 *     `ProcessData` (0x735010). Every one of those getters' results is dereferenced
 *     without a NULL test. `Init` is handed a 0x30-byte local whose fields it fills to
 *     +0x1b (0x7350b0), which is the caller-side half of the extent below.
 *   - RETURN KIND per slot is the instruction that last defines EAX on the reachable
 *     return paths: a write to AL is a bool, a leftover from the epilogue's `std::string`
 *     destructor (0x1000738d) is a void, an immediate is an enum, and a load of a cached
 *     `c_str()` is a `const char*`. `IApps::GetCurrentGameLanguage` (0x1011e680) and
 *     `GetCurrentGameLanguageCode` (0x1011ea20) additionally carry the DLL's own defaults
 *     as literals — 0x1089b590 "english" and 0x1089b5d8 "en-US" — which is where the
 *     values in the table come from. `IUser::GetGalaxyID` (0x1013ea40) reads `[ebp+8]`
 *     into ESI and returns it: a struct-by-value, so its one pushed argument is the
 *     hidden buffer, not a parameter.
 *
 * KNOWN GAP: the factory generation's sub-interfaces above carry arity only. The same
 * "0 is not a pointer" hazard applies to them, and it is unmeasured here because the
 * binary that defines them is a different build (Worms World Party's), not the one in
 * this bundle. Measure it against that DLL before trusting those slots' returns.
 */

import { Process } from '../../core/process';
import { Logger, LogCategory } from '../../core/logger';
import { isValidAddress } from '../../core/memory/address-guard';
import { Mem } from '../../core/memory/mem-accessor';
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

/**
 * The later generation's free-function facade. `YA` — __cdecl, so the CALLER cleans up
 * and our stubs pop nothing; `Init` is the only one with an argument.
 */
export const GOG_GALAXY_API_EXPORTS = {
    init: '?Init@api@galaxy@@YAXABUInitOptions@12@@Z',
    shutdown: '?Shutdown@api@galaxy@@YAXXZ',
    processData: '?ProcessData@api@galaxy@@YAXXZ',
    user: '?User@api@galaxy@@YAPAVIUser@12@XZ',
    apps: '?Apps@api@galaxy@@YAPAVIApps@12@XZ',
    stats: '?Stats@api@galaxy@@YAPAVIStats@12@XZ',
    utils: '?Utils@api@galaxy@@YAPAVIUtils@12@XZ',
} as const;

/**
 * `galaxy::api::InitOptions` — the by-reference argument of `Init`. Not a layout we
 * claim to know field by field: this is the extent Galaxy.dll's own `Init` dereferences
 * (highest touched member is a word at +0x1c), rounded to the struct's pointer alignment.
 */
export const GOG_GALAXY_INIT_OPTIONS_SIZE = 0x20;

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

/**
 * WHAT A SLOT LEAVES IN EAX is part of the contract, alongside the arity.
 *
 * Answering 0 is only safe where the real method returns void, a bool or an integer. A
 * slot that returns a POINTER answers a value the guest dereferences, and the SDK's own
 * `const char*` getters never return NULL — they return an empty string when nothing is
 * set, which is why callers `strcmp` the result with no NULL test (The Bard's Tale does
 * exactly that on `IApps::GetCurrentGameLanguage`). That is the same hazard the factory
 * getters have, one level deeper.
 *
 * `str` is a `const char*`; the text is the DLL's own default where it has one, else "".
 * `sret` is a struct returned BY VALUE: MSVC pushes a hidden buffer as the first argument
 * and the callee returns THAT pointer in EAX, so the slot must hand `args[0]` back.
 */
type SlotReturn =
    | { readonly kind: 'str'; readonly text: string }
    | { readonly kind: 'sret'; readonly bytes: number };

const str = (text: string): SlotReturn => ({ kind: 'str', text });
const sret = (bytes: number): SlotReturn => ({ kind: 'sret', bytes });

/** args, the name the shipped facade logs for itself, and the return kind when 0 is wrong. */
type SlotSpec = readonly [args: number, name: string, returns?: SlotReturn];

/** `${interface}_${method}` -> the value the slot must answer. */
const slotReturns = new Map<string, SlotReturn>();

/**
 * A facade interface: every slot named by the shipped DLL and measured for BOTH arity and
 * return kind. Unlike `iface` above, nothing here is positional guesswork.
 */
function facadeIface(name: string, slots: readonly SlotSpec[]): InterfaceDescriptor {
    for (const [, methodName, returns] of slots) {
        if (returns) slotReturns.set(`${name}_${methodName}`, returns);
    }
    return { name, methods: slots.map(([args, methodName]) => method(methodName, args)) };
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

/**
 * The free-function generation's interfaces, each the subobject at +0x34 of the facade
 * the matching getter hands out. Named after the RTTI class the transcription came from,
 * because that — not the SDK header we do not have — is what was measured.
 *
 * Slot NAMES are the shipped DLL's own: every facade method pushes its name as a literal
 * for its `%s: …: error=%s` log line, so the names are read out of the binary like the
 * arities. The three slots the DLL never names keep a positional one.
 *
 * galaxy::api::IUser — PeerUserFacade vftable 0x10896c84, 38 slots.
 * SignInPS4/XB1/Xbox log "method not available on this platform" and throw; slot 12 logs
 * "Specified method is not implemented on current facade" and throws. They have no normal
 * return, so there is nothing for them to answer.
 */
const IUserFacade = facadeIface('IUserFacade', [
    [1, 'Destructor'],
    [0, 'SignedIn'],
    [1, 'GetGalaxyID', sret(8)],
    [3, 'SignInCredentials'],
    [2, 'SignInToken'],
    [1, 'SignInLauncher'],
    [4, 'SignInSteam'],
    [2, 'SignInGalaxy'],
    [0, 'SignInPS4'],
    [0, 'SignInXB1'],
    [0, 'SignInXbox'],
    [5, 'SignInXBLive'],
    [1, 'Slot12'],
    [1, 'SignInAnonymousTelemetry'],
    [2, 'SignInServerKey'],
    [3, 'SignInAuthorizationCode'],
    [0, 'SignOut'],
    [3, 'RequestUserData'],
    [2, 'IsUserDataAvailable'],
    [3, 'GetUserData', str('')],
    [5, 'GetUserDataCopy'],
    [3, 'SetUserData'],
    [2, 'GetUserDataCount'],
    [7, 'GetUserDataByIndex'],
    [2, 'DeleteUserData'],
    [0, 'IsLoggedOn'],
    [3, 'RequestEncryptedAppTicket'],
    [3, 'GetEncryptedAppTicket'],
    [5, 'CreateOpenIDConnection'],
    [7, 'LoginWithOpenIDConnect'],
    [0, 'GetSessionID'],
    [0, 'GetAccessToken', str('')],
    [2, 'GetAccessTokenCopy'],
    [0, 'GetRefreshToken', str('')],
    [2, 'GetRefreshTokenCopy'],
    [0, 'GetIDToken', str('')],
    [2, 'GetIDTokenCopy'],
    [2, 'ReportInvalidAccessToken'],
]);
/** galaxy::api::IStats — StatsFacade vftable 0x10899a98, 35 slots. */
const IStatsFacade = facadeIface('IStatsFacade', [
    [1, 'Destructor'],
    [3, 'RequestUserStatsAndAchievements'],
    [3, 'GetStatInt'],
    [3, 'GetStatFloat'],
    [2, 'SetStatInt'],
    [2, 'SetStatFloat'],
    [4, 'UpdateAvgRateStat'],
    [5, 'GetAchievement'],
    [1, 'SetAchievement'],
    [1, 'ClearAchievement'],
    [1, 'StoreStatsAndAchievements'],
    [1, 'ResetStatsAndAchievements'],
    [1, 'GetAchievementDisplayName', str('')],
    [3, 'GetAchievementDisplayNameCopy'],
    [1, 'GetAchievementDescription', str('')],
    [3, 'GetAchievementDescriptionCopy'],
    [1, 'IsAchievementVisible'],
    [1, 'IsAchievementVisibleWhileLocked'],
    [1, 'RequestLeaderboards'],
    [1, 'GetLeaderboardDisplayName', str('')],
    [3, 'GetLeaderboardDisplayNameCopy'],
    [1, 'GetLeaderboardSortMethod'],
    [1, 'GetLeaderboardDisplayType'],
    [4, 'RequestLeaderboardEntriesGlobal'],
    [6, 'RequestLeaderboardEntriesAroundUser'],
    [4, 'RequestLeaderboardEntriesForUsers'],
    [4, 'GetRequestedLeaderboardEntry'],
    [7, 'GetRequestedLeaderboardEntryWithDetails'],
    [4, 'SetLeaderboardScore'],
    [6, 'SetLeaderboardScoreWithDetails'],
    [1, 'GetLeaderboardEntryCount'],
    [2, 'FindLeaderboard'],
    [5, 'FindOrCreateLeaderboard'],
    [3, 'RequestUserTimePlayed'],
    [2, 'GetUserTimePlayed'],
]);
/** galaxy::api::IUtils — PeerUtilsFacade vftable 0x1089aa14, 10 slots. */
const IUtilsFacade = facadeIface('IUtilsFacade', [
    [1, 'Destructor'],
    [3, 'GetImageSize'],
    [3, 'GetImageRGBA'],
    [1, 'RegisterForNotification'],
    [7, 'GetNotification'],
    [1, 'ShowOverlayWithWebPage'],
    [0, 'IsOverlayVisible'],
    [0, 'GetOverlayState'],
    [1, 'DisableOverlayPopups'],
    [0, 'GetGogServicesConnectionState'],
]);
/** galaxy::api::IApps — AppsFacade vftable 0x1089b514, 7 slots. */
const IAppsFacade = facadeIface('IAppsFacade', [
    [1, 'Destructor'],
    [2, 'IsDlcInstalled'],
    [3, 'IsDlcOwned'],
    [2, 'GetCurrentGameLanguage', str('english')],
    [4, 'GetCurrentGameLanguageCopy'],
    [2, 'GetCurrentGameLanguageCode', str('en-US')],
    [4, 'GetCurrentGameLanguageCodeCopy'],
]);

const INTERFACES: readonly InterfaceDescriptor[] = [
    IGalaxy, IErrorManager, IError,
    IUser, IFriends, IMatchmaking, INetworking, IStats, IListenerRegistrar, IGalaxyUnknown,
    IUserFacade, IStatsFacade, IUtilsFacade, IAppsFacade,
];

const gogGalaxyDescriptor: ModuleDescriptor = {
    name: 'galaxy',
    functions: [],
    interfaces: [...INTERFACES],
};

/**
 * The published shape — interface name -> pushed-arg count per slot, in slot order.
 * Derived from the descriptors the vtables are actually built from, so the test that
 * pins it is testing what the guest gets rather than a second copy of the numbers.
 */
export const GOG_GALAXY_INTERFACE_LAYOUTS: Readonly<Record<string, readonly number[]>> =
    Object.freeze(Object.fromEntries(
        INTERFACES.map((d) => [d.name, Object.freeze(d.methods.map((m) => m.params.length))])));

/**
 * `${interface}_${method}` -> the slot's return kind, for the slots where 0 is not an
 * answer the real method can give. The pinned counterpart of the layouts above: a slot
 * silently reclassified as void is a NULL the guest dereferences.
 */
export const GOG_GALAXY_SLOT_RETURNS: ReadonlyMap<string, SlotReturn> = slotReturns;

/** Every interface this module publishes, for the tests that pin their shape. */
export const GOG_GALAXY_INTERFACES: readonly InterfaceDescriptor[] = INTERFACES;

/** GalaxyError::GALAXY_ERROR / UNAUTHORIZED_ACCESS — "no client", the offline branch. */
const GALAXY_ERROR_TYPE = 1;

let vtables: Record<string, VTableInfo> | null = null;
let galaxyInstance = 0;
/** One object per interface name — the SDK's own getters are singletons too. */
const singletons = new Map<string, number>();
/** Status of the LAST SDK call — see IErrorManager::GetError below. */
let lastCallFailed = false;
/** The free-function generation's "the singletons exist" state — set by Init, cleared by Shutdown. */
let apiInitialized = false;
/** Backing store for the `const char*` slots, keyed by text. */
const stringPool = new Map<string, number>();
const ZERO_SRET = new Uint8Array(16);

/**
 * A C string in guest memory with a PROCESS-LIFETIME address. The SDK's `const char*`
 * getters promise a pointer that outlives the call — titles cache it — so this comes from
 * a system block that we never release, and an unreleased block is never handed to
 * another owner. Interning by text keeps repeat calls at one allocation.
 */
function guestString(process: Process, text: string): number {
    const existing = stringPool.get(text);
    if (existing) return existing;
    const bytes = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    const addr = process.memory.allocSystemBlock(bytes.length) >>> 0;
    Mem.writeBytes(addr, bytes);
    stringPool.set(text, addr);
    return addr;
}

export function resetGogGalaxyState(): void {
    vtables = null;
    galaxyInstance = 0;
    singletons.clear();
    lastCallFailed = false;
    apiInitialized = false;
    stringPool.clear();
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

    // ── The free-function facade ────────────────────────────────────────────────────
    // `Init` takes `const InitOptions&`, so the one pushed argument is a guest pointer
    // the real SDK dereferences. Validate the whole extent it reads against the region
    // map before trusting it: a bounds test would accept a pointer into THUNK_CODE or a
    // red zone. We read nothing out of it — there is nothing in a client id or a config
    // path a locally-constructed SDK can act on — but a reference the real Init would
    // have faulted on must not read back as a clean success.
    exports[GOG_GALAXY_API_EXPORTS.init] = (_ctx, mem, args) => {
        const options = args[0] >>> 0;
        if (!isValidAddress(mem, options, GOG_GALAXY_INIT_OPTIONS_SIZE, 'r')) {
            Logger.warn(LogCategory.SYSTEM,
                `[Galaxy] api::Init: unreadable InitOptions& 0x${options.toString(16)}`);
            lastCallFailed = true;
            return 0;
        }
        apiInitialized = true;
        lastCallFailed = false;
        return 0;
    };

    // Shutdown destroys the singletons and NULLs the statics behind them, so the getters
    // answer NULL again afterwards. Our objects are kept — the guest may still hold a
    // pointer to one, and handing the same object back on a later Init costs nothing.
    exports[GOG_GALAXY_API_EXPORTS.shutdown] = () => {
        apiInitialized = false;
        lastCallFailed = false;
        return 0;
    };

    // The per-frame pump. Locally there is no client traffic to dispatch and no listener
    // registered through us, so it does nothing — but it must stay cheap: titles call it
    // once per frame, some once per subsystem per frame.
    exports[GOG_GALAXY_API_EXPORTS.processData] = () => 0;

    // The getters are a read of the singleton with a NULL check, not a throwing accessor:
    // `mov eax,[g]; test eax,eax; je -> xor eax,eax`. So NULL before Init and after
    // Shutdown is the SHIPPED behaviour, not a decline of ours, and answering an object
    // there would be the invention.
    const apiGetter = (target: string) => () => {
        if (!apiInitialized) return 0;
        lastCallFailed = false;
        return objectFor(target);
    };
    exports[GOG_GALAXY_API_EXPORTS.user] = apiGetter('IUserFacade');
    exports[GOG_GALAXY_API_EXPORTS.apps] = apiGetter('IAppsFacade');
    exports[GOG_GALAXY_API_EXPORTS.stats] = apiGetter('IStatsFacade');
    exports[GOG_GALAXY_API_EXPORTS.utils] = apiGetter('IUtilsFacade');

    // …and the slots where 0 is not a value the real method can return. Installed AFTER
    // the blanket no-op loop above, which is what makes that loop's "answer 0" a decision
    // about void/bool/integer slots rather than a default applied to everything.
    for (const [key, ret] of slotReturns) {
        if (ret.kind === 'str') {
            exports[key] = () => { lastCallFailed = false; return guestString(process, ret.text); };
        } else {
            exports[key] = (_ctx, mem, args) => {
                const out = args[0] >>> 0;
                if (!isValidAddress(mem, out, ret.bytes, 'rw')) { lastCallFailed = true; return 0; }
                // Zero IS the answer: an all-zero GalaxyID is the invalid one, which is
                // what "nobody is signed in" means. Leaving the caller's uninitialised
                // buffer alone would hand it a plausible id instead.
                Mem.writeBytes(out, ZERO_SRET.subarray(0, ret.bytes));
                lastCallFailed = false;
                return out;
            };
        }
    }

    return exports;
}
