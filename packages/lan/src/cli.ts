import { createLanServer, type LanServerOptions } from "./server";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
function value(flag: string, fallback: string): string {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Missing value for " + flag);
    return args[index + 1];
}
if (args.includes("--help")) {
    console.log("bottleship-lan [--config server.json] [--host 127.0.0.1] [--port 9001] [--origin https://bottleship.example]");
    process.exit(0);
}
const configPath = value("--config", "");
const config: LanServerOptions = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("Server configuration must be an object");
const port = Number(value("--port", String(config.port ?? 9001)));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("Invalid port");
const host = value("--host", config.host ?? "127.0.0.1");
const origin = value("--origin", "");
const server = createLanServer({ ...config, host, port, allowedOrigins: origin ? origin === "*" ? "*" : origin.split(",") : config.allowedOrigins });
const actualPort = await server.listen();
console.log("bottleship-lan listening on http://" + host + ":" + actualPort + " (WebSocket + HTTP long-polling)");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    void server.close().then(() => process.exit(0));
});
