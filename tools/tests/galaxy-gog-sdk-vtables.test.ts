/**
 * The GOG Galaxy SDK's published vtable shapes, pinned.
 *
 * Slot ORDER and per-slot PUSHED-ARG COUNT are the whole contract: the guest calls slot N
 * and the stub's `RET imm16` pops what that slot declares, so an inserted, reordered or
 * mis-sized slot walks the caller's ESP off its own frame and faults somewhere with no
 * connection to Galaxy. The numbers below are transcriptions from the shipped binaries
 * (provenance in modules/galaxy/gog-sdk.ts) — this file exists so an edit has to change
 * them deliberately, and it asserts them literally rather than through a snapshot so a
 * missing baseline cannot make it vacuous.
 */

import { describe, expect, test } from "bun:test";
import {
    GOG_GALAXY_API_EXPORTS,
    GOG_GALAXY_EXPORTS,
    GOG_GALAXY_INIT_OPTIONS_SIZE,
    GOG_GALAXY_INTERFACE_LAYOUTS,
    GOG_GALAXY_INTERFACES,
    GOG_GALAXY_SLOT_RETURNS,
} from "../../src/worker/modules/galaxy/gog-sdk";
import { galaxyModule } from "../../src/worker/api/galaxy.api";

/** GalaxyFactory generation — Galaxy.dll of Worms World Party (see gog-sdk.ts). */
const FACTORY_LAYOUTS: Record<string, number[]> = {
    IGalaxy: [1, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    IErrorManager: [1, 0],
    IError: [1, 0, 0, 0, 2],
    IUser: [1, 0, 1, 0, 3, 2, 0, 1, 2, 0, 5, 1, 0],
    IFriends: [1, 0, 2, 3, 2, 2, 1, 0, 1],
    IMatchmaking: [1, 2, 0, 3, 3, 2, 2, 2, 2, 2, 2, 4, 2, 3, 4, 2, 7, 3, 5, 4, 4, 9, 3, 3, 4, 6],
    INetworking: [1, 6, 5, 2, 5, 1, 2],
    IStats: [1, 2, 3, 3, 2, 2, 4, 5, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 3, 5, 3, 4, 3],
    IListenerRegistrar: [1, 2, 2],
    IGalaxyUnknown: [1, 0, 0, 0, 0, 0, 0, 0],
};

/** galaxy::api free-function generation — Galaxy.dll of The Bard's Tale ARPG. */
const API_LAYOUTS: Record<string, number[]> = {
    IUserFacade: [
        1, 0, 1, 3, 2, 1, 4, 2, 0, 0, 0, 5, 1, 1, 2, 3, 0, 3, 2,
        3, 5, 3, 2, 7, 2, 0, 3, 3, 5, 7, 0, 0, 2, 0, 2, 0, 2, 2,
    ],
    IStatsFacade: [
        1, 3, 3, 3, 2, 2, 4, 5, 1, 1, 1, 1, 1, 3, 1, 3, 1, 1,
        1, 1, 3, 1, 1, 4, 6, 4, 4, 7, 4, 6, 1, 2, 5, 3, 2,
    ],
    IUtilsFacade: [1, 3, 3, 1, 7, 1, 0, 0, 1, 0],
    IAppsFacade: [1, 2, 3, 2, 4, 2, 4],
};

describe("GOG Galaxy vtable layouts", () => {
    for (const [name, args] of Object.entries({ ...FACTORY_LAYOUTS, ...API_LAYOUTS })) {
        test(`${name} publishes ${args.length} slots with the measured arities`, () => {
            const published = GOG_GALAXY_INTERFACE_LAYOUTS[name];
            expect(published).toBeDefined();
            expect(published!.length).toBe(args.length);
            expect([...published!]).toEqual(args);
        });
    }

    test("every published interface is pinned here", () => {
        expect(Object.keys(GOG_GALAXY_INTERFACE_LAYOUTS).sort())
            .toEqual([...Object.keys(FACTORY_LAYOUTS), ...Object.keys(API_LAYOUTS)].sort());
    });

    test("slot 0 is MSVC's scalar deleting destructor everywhere — one pushed flag", () => {
        for (const args of Object.values(GOG_GALAXY_INTERFACE_LAYOUTS)) {
            expect(args[0]).toBe(1);
        }
    });

    // The two generations describe the same interface NAMES at different shapes; sharing
    // one of those layouts across both is the mistake this asserts against.
    test("the api generation's IUser is not the factory generation's", () => {
        expect(GOG_GALAXY_INTERFACE_LAYOUTS.IUserFacade)
            .not.toEqual(GOG_GALAXY_INTERFACE_LAYOUTS.IUser as number[]);
    });
});

/**
 * The slots whose real method returns a POINTER. Answering 0 for one of these is the bug
 * this pins: the SDK's `const char*` getters return an empty string, never NULL, so the
 * guest `strcmp`s the result unchecked — which is how a live boot died inside
 * `IApps::GetCurrentGameLanguage`. A slot dropping off this list is that bug returning.
 */
const POINTER_SLOTS: Record<string, { kind: string; text?: string; bytes?: number }> = {
    // Struct by value: the one pushed argument is MSVC's hidden return buffer, and the
    // callee hands that pointer back in EAX.
    IUserFacade_GetGalaxyID: { kind: "sret", bytes: 8 },
    IUserFacade_GetUserData: { kind: "str", text: "" },
    IUserFacade_GetAccessToken: { kind: "str", text: "" },
    IUserFacade_GetRefreshToken: { kind: "str", text: "" },
    IUserFacade_GetIDToken: { kind: "str", text: "" },
    IStatsFacade_GetAchievementDisplayName: { kind: "str", text: "" },
    IStatsFacade_GetAchievementDescription: { kind: "str", text: "" },
    IStatsFacade_GetLeaderboardDisplayName: { kind: "str", text: "" },
    // The DLL's OWN defaults, read off the literals its body carries (0x1089b590 /
    // 0x1089b5d8). That is the oracle here, and it has to be: the title's dispatch
    // (exe 0x735180) is a chain of case-sensitive inline strcmps mapping french->2,
    // german->3, italian->9, korean->4, polish->5, russian->6, spanish->1 with EVERYTHING
    // ELSE falling through to English, so a typo, an empty string or "English" would all
    // still reach an English menu. Only comparing against the shipped literal can tell
    // the right answer from one that merely survives. Casing is load-bearing for the
    // same reason it is invisible: the compare folds no case, and the exe's uppercase
    // ENGLISH/FRENCH table belongs to something else — `?Apps@` has exactly one call
    // site in the image, and this is it.
    IAppsFacade_GetCurrentGameLanguage: { kind: "str", text: "english" },
    IAppsFacade_GetCurrentGameLanguageCode: { kind: "str", text: "en-US" },
};

describe("GOG Galaxy slot return kinds", () => {
    test("exactly the measured pointer-returning slots are declared", () => {
        expect([...GOG_GALAXY_SLOT_RETURNS.keys()].sort())
            .toEqual(Object.keys(POINTER_SLOTS).sort());
    });

    for (const [key, expected] of Object.entries(POINTER_SLOTS)) {
        test(`${key} answers a ${expected.kind}`, () => {
            expect(GOG_GALAXY_SLOT_RETURNS.get(key)).toEqual(expected as never);
        });
    }

    // Slots are reached by `${interface}_${method}`, and the stub table is keyed by that
    // name — so two slots sharing one name collapse to a single stub, and the slot with
    // the other arity gets that stub's RET N. The layout test cannot see it: the method
    // count, and so the published arity list, stays right.
    test("no interface names two slots the same", () => {
        for (const descriptor of GOG_GALAXY_INTERFACES) {
            const names = descriptor.methods.map((m) => m.name);
            expect([descriptor.name, names.length])
                .toEqual([descriptor.name, new Set(names).size]);
        }
    });

    // A pointer slot is reached by NAME, so a rename that loses the declaration would
    // otherwise pass the layout test and silently restore the NULL.
    test("every declared slot name exists on its interface", () => {
        for (const key of GOG_GALAXY_SLOT_RETURNS.keys()) {
            const iface = key.slice(0, key.indexOf("_"));
            expect(GOG_GALAXY_INTERFACE_LAYOUTS[iface]).toBeDefined();
        }
    });
});

describe("GOG Galaxy exports", () => {
    const declared = new Map(galaxyModule.functions.map((f) => [f.name, f]));

    test("the 7 free-function names the api generation imports are declared", () => {
        expect(Object.values(GOG_GALAXY_API_EXPORTS).sort()).toEqual([
            "?Apps@api@galaxy@@YAPAVIApps@12@XZ",
            "?Init@api@galaxy@@YAXABUInitOptions@12@@Z",
            "?ProcessData@api@galaxy@@YAXXZ",
            "?Shutdown@api@galaxy@@YAXXZ",
            "?Stats@api@galaxy@@YAPAVIStats@12@XZ",
            "?User@api@galaxy@@YAPAVIUser@12@XZ",
            "?Utils@api@galaxy@@YAPAVIUtils@12@XZ",
        ]);
        for (const name of Object.values(GOG_GALAXY_API_EXPORTS)) {
            expect(declared.has(name)).toBe(true);
        }
    });

    // `YA` is __cdecl: the caller cleans up, so the stub must `ret` and pop nothing.
    // Declaring these stdcall-with-cleanup-0 would read the same for the void ones and
    // pop 4 from under Init's caller.
    test("the free functions are cdecl, and only Init takes an argument", () => {
        for (const name of Object.values(GOG_GALAXY_API_EXPORTS)) {
            const fn = declared.get(name)!;
            expect(fn.callingConvention).toBe("cdecl");
            expect(fn.params.length).toBe(name === GOG_GALAXY_API_EXPORTS.init ? 1 : 0);
        }
    });

    test("the factory entry points are untouched", () => {
        for (const name of Object.values(GOG_GALAXY_EXPORTS)) {
            expect(declared.has(name)).toBe(true);
        }
    });

    test("InitOptions is validated over the extent the real Init reads", () => {
        // Fields at +0x00 .. +0x1c (word) — see the provenance note in gog-sdk.ts.
        expect(GOG_GALAXY_INIT_OPTIONS_SIZE).toBe(0x20);
    });

    // The Unreal audio Galaxy.dll shares this module name; assignStubsOnce reports a
    // collision rather than overwriting, and a duplicate declaration here would lay two
    // stub bodies under one name.
    test("no export name is declared twice", () => {
        const names = galaxyModule.functions.map((f) => f.name);
        expect(names.length).toBe(new Set(names).size);
    });
});
