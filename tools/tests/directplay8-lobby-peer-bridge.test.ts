import { expect, test } from "bun:test";
import type { Process } from "../../src/worker/core/process";
import { LobbyPeerRegistration, registerLobbyPeerProvider } from "../../src/worker/modules/dpnlobby/peer-bridge";
import { DPN } from "../../src/worker/modules/dpnet/constants";
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
test("RegisterLobby bridge bounds retained work and retries ordered publications without dropping updates", async () => {
    const process = {} as Process, accepted: number[] = []; let blocked = true, drops = 0, active = 0, peak = 0;
    registerLobbyPeerProvider(process, {
        retain: () => () => { drops++; },
        post: async (_pointer, _connection, status) => {
            active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
            if (blocked) return DPN.TABLEFULL;
            accepted.push(status); return 0;
        },
    });
    const registration = LobbyPeerRegistration.create(process, 0x1000, 99)!;
    for (let i = 0; i < 64; i++) expect(registration.tryPublish(i)).toBe(true);
    expect(registration.tryPublish(100)).toBe(false); expect(registration.pending).toBe(64); expect(drops).toBe(0);
    blocked = false; await registration.flush();
    expect(accepted).toEqual(Array.from({ length: 64 }, (_, i) => i)); expect(peak).toBe(1);
    registration.release(); registration.release(); expect(drops).toBe(1);
});
test("RegisterLobby release cancels an in-flight provider reply without corrupting the new queue lifetime", async () => {
    const process = {} as Process; let reply!: (hr: number) => void, drops = 0;
    registerLobbyPeerProvider(process, { retain: () => () => { drops++; }, post: () => new Promise(resolve => { reply = resolve; }) });
    const registration = LobbyPeerRegistration.create(process, 0x1000, 7)!;
    const pending = registration.publish(1); const flushed = registration.flush();
    registration.release(); await pending; await flushed; expect(registration.pending).toBe(0); expect(drops).toBe(1);
    reply(0); await tick(); expect(registration.pending).toBe(0); expect(registration.tryPublish(2)).toBe(false); expect(drops).toBe(1);
});
test("RegisterLobby publication started by a completion cannot get stranded at the end of the old pump", async () => {
    const process = {} as Process, received: number[] = [];
    registerLobbyPeerProvider(process, { retain: () => () => {}, post: (_pointer, _connection, status) => { received.push(status); return 0; } });
    const registration = LobbyPeerRegistration.create(process, 0x1000, 9)!;
    await registration.publish(1).then(() => registration.publish(2));
    expect(received).toEqual([1, 2]); registration.release();
});
