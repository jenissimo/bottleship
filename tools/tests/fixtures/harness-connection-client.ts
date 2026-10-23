import assert from "node:assert/strict";

const [endpoint, mode] = process.argv.slice(2);
assert(endpoint && mode);
const address = new URL(endpoint);
assert.equal(address.hostname, "127.0.0.1");
process.env.BS_CDP_PORT = address.port;
process.env.BS_TAB = "connection-fixture";
process.env.BS_URL_MATCH = "http://fixture.invalid";

const { harness, closeHarnessConnection } = await import("../../harness");
const run = () => harness().evalPage("true", 1000).run();
const observed = (promise: ReturnType<typeof run>) => promise.then(
    (value) => ({ ok: value.ok, error: undefined }),
    (error) => ({ ok: false, error: String(error) }),
);
const state = () => fetch(endpoint + "/state").then((response) => response.json()) as Promise<{ lists: number }>;
async function untilLists(count: number) {
    const deadline = Date.now() + 3000;
    while ((await state()).lists < count) {
        assert(Date.now() < deadline, "Controlled target lookup not reached");
        await Bun.sleep(1);
    }
}
const release = (number: number) => fetch(endpoint + "/release/" + number).then((response) => {
    assert(response.ok);
});

let result: unknown;
try {
    if (mode === "concurrent") {
        const values = await Promise.all(Array.from({ length: 4 }, () => run()));
        assert(values.every((value) => value.ok));
        result = { completed: 4 };
    } else if (mode === "pending") {
        const pending = observed(run());
        await untilLists(1);
        closeHarnessConnection();
        await release(1);
        result = { old: await pending };
    } else if (mode === "overlap") {
        const pending = observed(run());
        await untilLists(1);
        closeHarnessConnection();
        const newer = observed(run());
        await untilLists(2);
        await release(1);
        const old = await pending;
        // Old finalization must leave the newer acquisition available for this caller.
        const joined = observed(run());
        await release(2);
        result = { old, newer: await newer, joined: await joined };
    } else if (mode === "retry") {
        const first = await observed(run());
        const second = await observed(run());
        result = { first, second };
    } else if (mode === "reopen") {
        const first = await observed(run());
        closeHarnessConnection();
        const second = await observed(run());
        result = { first, second };
    } else {
        throw new Error("Unknown fixture mode");
    }
} finally {
    closeHarnessConnection();
}
console.log("@@HARNESS_LIFETIME@@" + JSON.stringify(result));
// Natural process exit is part of this fixture. Never force process.exit() to hide leaked CDP sockets.
