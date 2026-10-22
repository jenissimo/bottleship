import { harness, closeHarnessConnection } from "../harness";

const config = {
    serverUrl: process.env.BS_LAN_SERVER ?? "http://127.0.0.1:9001",
    room: process.env.BS_LAN_ROOM ?? "conformance",
};
try {
    const connect = `new Promise((resolve, reject) => {
        const worker = window.worker;
        let timer;
        const done = event => {
            if (event.data?.type !== "network_state") return;
            const status = event.data.status;
            if (!["connected", "error"].includes(status.state)) return;
            clearTimeout(timer);
            worker.removeEventListener("message", done);
            if (status.state === "connected") resolve(status); else reject(new Error(status.reason));
        };
        worker.addEventListener("message", done);
        timer = setTimeout(() => {
            worker.removeEventListener("message", done);
            reject(new Error("LAN connection timed out"));
        }, 15000);
        worker.postMessage({type:"set_network",network:${JSON.stringify(config)}});
    })`;
    const result = await harness().reload().evalPage(connect, 20000).call("networkState").run();
    const state = result.named.networkState as { connected?: boolean; config?: typeof config };
    if (!result.ok || !state?.connected || state.config?.room !== config.room) {
        throw new Error("Browser LAN setup failed: " + JSON.stringify(result));
    }
    console.log(JSON.stringify(state, null, 2));
    const disconnected = await harness().evalPage(`new Promise(resolve => {
        const worker = window.worker;
        const done = event => {
            if (event.data?.type !== "network_state" || event.data.status.state !== "offline") return;
            worker.removeEventListener("message", done);
            resolve(true);
        };
        worker.addEventListener("message", done);
        worker.postMessage({type:"set_network",network:null});
    })`, 5000).call("networkState").run();
    if (!disconnected.ok || (disconnected.named.networkState as { connected?: boolean })?.connected) {
        throw new Error("Browser LAN disconnect failed: " + JSON.stringify(disconnected));
    }
} finally {
    closeHarnessConnection();
}
