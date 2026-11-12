import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { DPlayX, DPLAYX_FIELDS } from "../../src/worker/modules/dplayx/dplayx";
import { DirectPlayNetworkApi } from "../../src/worker/modules/dplayx/network-api";
import { DirectPlayLobbyEndpoint } from "../../src/worker/modules/dplayx/lobby-broker";
import { ProcessIpc } from "../../src/worker/core/process-ipc";
import { HleComServer } from "../../src/worker/core/com/hle-com-server";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";

type Internals = Record<string, unknown>;

void System;

function idle(): { module: DPlayX & Internals; api: DirectPlayNetworkApi & Internals; server: HleComServer & Internals } {
    const process = {} as never;
    const api = new DirectPlayNetworkApi(process, () => ({})) as DirectPlayNetworkApi & Internals;
    const server = new HleComServer(process, { name: "dplayx" } as never, () => ({}), []) as HleComServer & Internals;
    const module = new DPlayX() as DPlayX & Internals;
    module.networkApi = api;
    module.comServer = server;
    return { module, api, server };
}

describe("dplayx idle participant", () => {
    test("an idle module saves nothing and restores into an idle module", () => {
        const { module } = idle();
        expect(module.captureSavestate()).toEqual({});
        expect(() => idle().module.restoreSavestate()).not.toThrow();
    });

    test("every instance field has a policy", () => {
        expect(Object.keys(new DPlayX()).sort()).toEqual(Object.keys(DPLAYX_FIELDS).sort());
    });

    test("each open DirectPlay thing refuses the save and is named", () => {
        const { module, api } = idle();
        const cases: Array<[string, () => void, () => void, string]> = [
            ["states", () => (api.states as Map<number, unknown>).set(0x1040, {}), () => (api.states as Map<number, unknown>).clear(), "DirectPlay object 0x1040"],
            ["lobbyInterfaces", () => (api.lobbyInterfaces as Map<number, unknown>).set(0x1044, new Map()), () => (api.lobbyInterfaces as Map<number, unknown>).clear(), "DirectPlayLobby object 0x1044"],
            ["lobbyEvents", () => (api.lobbyEvents as Map<number, unknown>).set(0x1048, new Map()), () => (api.lobbyEvents as Map<number, unknown>).clear(), "lobby event registration of 0x1048"],
            ["lobbyOwnedEvents", () => (api.lobbyOwnedEvents as Set<number>).add(0x204), () => (api.lobbyOwnedEvents as Set<number>).clear(), "lobby event 0x204"],
        ];
        for (const [field, open, close, name] of cases) {
            open();
            expect(() => module.captureSavestate()).toThrow(`dplayx: not idle, 1 thing(s) open: ${name}`);
            close();
            expect({ field, idle: module.captureSavestate() }).toEqual({ field, idle: {} });
        }
    });

    test("the lobby endpoint alone does not refuse the save", () => {
        const { module, api } = idle();
        api.lobbyEndpoint = new DirectPlayLobbyEndpoint(new ProcessIpc(1234));
        expect(module.captureSavestate()).toEqual({});
        (api.lobbyInterfaces as Map<number, unknown>).set(0x1044, new Map());
        expect(() => module.captureSavestate()).toThrow("dplayx: not idle, 1 thing(s) open: DirectPlayLobby object 0x1044");
    });

    test("a broker record of this process refuses the save and is named", () => {
        const refusal = "dplayx: not idle, 1 thing(s) open: the lobby record of this process";
        const settings = { desc: { application: "a".repeat(32) }, create: false, player: null, provider: "", address: new Uint8Array() } as never;
        const requests: Array<[string, object, object]> = [
            ["settings", { op: "set", settings }, { op: "resetOwner" }],
            ["wait", { op: "wait", flags: 0 }, { op: "wait", flags: 1 }],
            ["subscription", { op: "subscribe", flags: 1 }, { op: "subscribe", flags: 0 }],
        ];
        for (const [record, open, close] of requests) {
            const { module, api } = idle();
            const endpoint = api.lobbyEndpoint = new DirectPlayLobbyEndpoint(new ProcessIpc(1234));
            expect({ record, reply: endpoint.call(open as never) }).toEqual({ record, reply: { hr: 0 } });
            expect(() => module.captureSavestate()).toThrow(refusal);
            expect({ record, reply: endpoint.call(close as never) }).toEqual({ record, reply: { hr: 0 } });
            expect({ record, idle: module.captureSavestate() }).toEqual({ record, idle: {} });
        }
        const rootIpc = new ProcessIpc(1234), { module, api } = idle();
        const endpoint = api.lobbyEndpoint = new DirectPlayLobbyEndpoint(rootIpc);
        expect(endpoint.call({ op: "launch", pid: 5600, settings })).toEqual({ hr: 0, pid: 5600 });
        expect(module.captureSavestate()).toEqual({});
        rootIpc.markProcessExited(5600, 0);
        expect(() => module.captureSavestate()).toThrow(refusal);
        expect(endpoint.call({ op: "receive", game: 5600, output: true, capacity: 64 })).toMatchObject({ hr: 0, size: 20 });
        expect(module.captureSavestate()).toEqual({});
    });

    test("more than four open things are counted and the list is cut", () => {
        const { module, api } = idle();
        for (let i = 0; i < 6; i++) (api.states as Map<number, unknown>).set(0x2000 + i * 4, {});
        expect(() => module.captureSavestate()).toThrow("6 thing(s) open: DirectPlay object 0x2000, DirectPlay object 0x2004, DirectPlay object 0x2008, DirectPlay object 0x200c, …");
    });

    test("a locked class factory refuses the save", () => {
        const { module, server } = idle();
        server.locks = 2;
        expect(server.lockCount).toBe(2);
        expect(() => module.captureSavestate()).toThrow("class factory is locked 2 time(s)");
        server.locks = 0;
        expect(module.captureSavestate()).toEqual({});
    });

    test("a COM-held load alone does not refuse the save; an open object still does", () => {
        const { module, api, server } = idle();
        server.loaderReference = { release: () => undefined };
        expect(server.holdsLoaderReference).toBe(true);
        expect(module.captureSavestate()).toEqual({});
        (api.states as Map<number, unknown>).set(0x1040, {});
        expect(() => module.captureSavestate()).toThrow("dplayx: not idle, 1 thing(s) open: DirectPlay object 0x1040");
        (api.states as Map<number, unknown>).clear();
        server.locks = 1;
        expect(() => module.captureSavestate()).toThrow("class factory is locked 1 time(s)");
    });

    test("a restore into a session that is not idle fails", () => {
        const { module, api } = idle();
        (api.states as Map<number, unknown>).set(0x1040, {});
        expect(() => module.restoreSavestate()).toThrow("the fresh session is not idle: DirectPlay object 0x1040");
    });

    test("the registered participant covers dplayx, refuses with a CaptureRefusal and has a pinned schema", () => {
        const { module, api } = idle();
        const undo = module.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("dplayx")).toBe(true);
            expect(savestateParticipants.schemas().dplayx).toEqual({ version: 1, schemaHash: "6f9c863326dfbceb" });
            (api.states as Map<number, unknown>).set(0x1040, {});
            expect(() => savestateParticipants.all().find(p => p.id === "dplayx")!.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("dplayx")).toBe(false);
    });
});
