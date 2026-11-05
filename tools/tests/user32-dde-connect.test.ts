/**
 * DdeConnect only succeeds when a server offers the service.
 *
 * Programs commonly detect a running copy of themselves by connecting to their own DDE
 * service before calling DdeNameService. If DdeConnect answers with a conversation even
 * though nobody registered the service, such a program believes another instance is
 * running and exits. These cases pin the server-side bookkeeping: no server -> no
 * conversation, DdeNameService(DNS_REGISTER) -> conversation, DNS_UNREGISTER (by name,
 * by NULL, or via DdeUninitialize) -> no conversation again. The Explorer shell services
 * (Progman, Shell, Folders, AppProperties, as Wine's shell32 registers them), which
 * installers talk to, stay connectable. A NULL service or topic is a wildcard.
 */

import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createInputExports } from "../../src/worker/modules/user32/input";

const DNS_REGISTER = 0x0001;
const DNS_UNREGISTER = 0x0002;
const DMLERR_NO_ERROR = 0;
const DMLERR_NO_CONV_ESTABLISHED = 0x400a;
const DMLERR_DLL_USAGE = 0x4004;
const APPCMD_CLIENTONLY = 0x10;

const mem = new Uint8Array(0x10000);
const view = new DataView(mem.buffer);
Mem.bind(() => mem);
const exports = createInputExports();

const PID = 0x100;
const STR = 0x200;

function call(name: string, ...args: number[]): number {
    return (exports[name]({} as any, mem, args) as number) >>> 0;
}

function init(afCmd = 0): number {
    expect(call("DdeInitializeA", PID, 0, afCmd, 0)).toBe(DMLERR_NO_ERROR);
    return view.getUint32(PID, true);
}

function hsz(inst: number, text: string): number {
    const bytes = new TextEncoder().encode(text + "\0");
    mem.set(bytes, STR);
    const handle = call("DdeCreateStringHandleA", inst, STR, 1004);
    expect(handle).not.toBe(0);
    return handle;
}

function connect(inst: number, service: string, topic = "System"): number {
    return call("DdeConnect", inst, hsz(inst, service), hsz(inst, topic), 0);
}

describe("DdeConnect requires a registered service", () => {
    test("fails without a server and reports DMLERR_NO_CONV_ESTABLISHED", () => {
        const client = init();
        expect(connect(client, "UnregisteredGameService")).toBe(0);
        expect(call("DdeGetLastError", client)).toBe(DMLERR_NO_CONV_ESTABLISHED);
        call("DdeUninitialize", client);
    });

    test("succeeds after DdeNameService(DNS_REGISTER), fails again after DNS_UNREGISTER", () => {
        const server = init();
        const client = init();
        const service = hsz(server, "MyGameService");

        expect(connect(client, "MyGameService")).toBe(0);

        expect(call("DdeNameService", server, service, 0, DNS_REGISTER)).not.toBe(0);
        const conv = connect(client, "mygameservice");
        expect(conv).not.toBe(0);
        expect(call("DdeGetLastError", client)).toBe(DMLERR_NO_ERROR);
        expect(call("DdeDisconnect", conv)).toBe(1);
        expect(call("DdeDisconnect", conv)).toBe(0);

        expect(call("DdeNameService", server, service, 0, DNS_UNREGISTER)).not.toBe(0);
        expect(connect(client, "MyGameService")).toBe(0);
        expect(call("DdeGetLastError", client)).toBe(DMLERR_NO_CONV_ESTABLISHED);

        call("DdeUninitialize", client);
        call("DdeUninitialize", server);
    });

    test("DNS_UNREGISTER with a NULL name and DdeUninitialize drop all services of the instance", () => {
        const server = init();
        const client = init();
        call("DdeNameService", server, hsz(server, "ServiceA"), 0, DNS_REGISTER);
        call("DdeNameService", server, hsz(server, "ServiceB"), 0, DNS_REGISTER);
        expect(connect(client, "ServiceA")).not.toBe(0);
        expect(connect(client, "ServiceB")).not.toBe(0);

        call("DdeNameService", server, 0, 0, DNS_UNREGISTER);
        expect(connect(client, "ServiceA")).toBe(0);
        expect(connect(client, "ServiceB")).toBe(0);

        call("DdeNameService", server, hsz(server, "ServiceA"), 0, DNS_REGISTER);
        expect(connect(client, "ServiceA")).not.toBe(0);
        expect(call("DdeUninitialize", server)).toBe(1);
        expect(connect(client, "ServiceA")).toBe(0);
        call("DdeUninitialize", client);
    });

    test("a service stays connectable while another instance still registers it", () => {
        const first = init();
        const second = init();
        const client = init();
        call("DdeNameService", first, hsz(first, "Shared"), 0, DNS_REGISTER);
        call("DdeNameService", second, hsz(second, "Shared"), 0, DNS_REGISTER);
        call("DdeUninitialize", first);
        expect(connect(client, "Shared")).not.toBe(0);
        call("DdeUninitialize", second);
        expect(connect(client, "Shared")).toBe(0);
        call("DdeUninitialize", client);
    });

    test("Explorer shell services remain connectable without a registration", () => {
        const client = init();
        for (const service of ["PROGMAN", "Shell", "Folders", "AppProperties"]) {
            expect(connect(client, service)).not.toBe(0);
        }
        call("DdeUninitialize", client);
    });

    test("a NULL service connects to any registered server", () => {
        const server = init();
        const client = init();
        const topic = hsz(client, "GameTopic");
        expect(call("DdeConnect", client, 0, topic, 0)).toBe(0);
        expect(call("DdeGetLastError", client)).toBe(DMLERR_NO_CONV_ESTABLISHED);
        call("DdeNameService", server, hsz(server, "AnyServer"), 0, DNS_REGISTER);
        expect(call("DdeConnect", client, 0, hsz(client, "GameTopic"), 0)).not.toBe(0);
        call("DdeUninitialize", server);
        call("DdeUninitialize", client);
    });

    test("a NULL service reaches the shell for a shell topic or a NULL topic", () => {
        const client = init();
        expect(call("DdeConnect", client, 0, hsz(client, "PROGMAN"), 0)).not.toBe(0);
        expect(call("DdeConnect", client, 0, hsz(client, "Shell"), 0)).not.toBe(0);
        expect(call("DdeConnect", client, 0, 0, 0)).not.toBe(0);
        expect(call("DdeConnect", client, 0, hsz(client, "System"), 0)).toBe(0);
        call("DdeUninitialize", client);
    });

    test("a NULL topic with a named service follows the service", () => {
        const client = init();
        expect(call("DdeConnect", client, hsz(client, "Progman"), 0, 0)).not.toBe(0);
        expect(call("DdeConnect", client, hsz(client, "NobodyHere"), 0, 0)).toBe(0);
        call("DdeUninitialize", client);
    });

    test("an APPCMD_CLIENTONLY instance cannot register services", () => {
        const client = init(APPCMD_CLIENTONLY);
        expect(call("DdeNameService", client, hsz(client, "ClientOnly"), 0, DNS_REGISTER)).toBe(0);
        expect(call("DdeGetLastError", client)).toBe(DMLERR_DLL_USAGE);
        const other = init();
        expect(connect(other, "ClientOnly")).toBe(0);
        call("DdeUninitialize", other);
        call("DdeUninitialize", client);
    });

    test("DdeNameService on an unknown instance fails", () => {
        expect(call("DdeNameService", 0xdead, 0, 0, DNS_REGISTER)).toBe(0);
    });
});
