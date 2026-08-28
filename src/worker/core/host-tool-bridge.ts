/**
 * host-tool-bridge.ts — run a console tool the guest spawned on the DEV HOST.
 *
 * Some engines compile their own content at run time by shelling out to a console
 * tool that ships beside the game: CryEngine runs `Bin32/fxc.exe` to turn each shader
 * permutation into D3D assembly, reads the listing back, assembles it, and caches the
 * result on disk. We have no x86 console host, so CreateProcess refuses honestly and the
 * engine keeps every shader it could not compile — which is why Far Cry's world renders
 * unshaded while its menus (cached) are fine.
 *
 * This bridge is the DEV-TIME answer: the guest's spawn is forwarded to the dev sidecar,
 * which runs that same tool natively and hands back whatever it produced. The point is to
 * let the game populate its OWN on-disk cache once, so the cache can be packed into the
 * bundle — after which no player, and no shipped code path, needs any of this. It is
 * therefore off unless a harness run turns it on, and the sidecar refuses any tool the dev
 * did not name in BS_HOST_TOOLS.
 */

import { Logger, LogCategory } from "./logger";

/** Set by the harness (`setWorkerFlag('__hostTools', true)`); never on by default. */
export function hostToolsEnabled(): boolean {
    return !!(globalThis as { __hostTools?: boolean }).__hostTools;
}

const SIDECAR_PORT = Number((import.meta as { env?: Record<string, string> }).env?.VITE_SIDECAR_PORT ?? 3001);

export interface HostToolFile {
    name: string;
    bytes: Uint8Array;
}

export interface HostToolResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    /** Every file the tool created in its scratch directory, by bare name. */
    outputs: HostToolFile[];
}

function toBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Run `tool` with `args` in a scratch directory seeded with `files`, and return what it
 * produced. Returns null when the bridge is off, the sidecar is unreachable, or the tool
 * is not allow-listed — every one of which must read as "we could not run it", never as a
 * silent success that leaves the guest reading a file that was never written.
 */
export async function runHostTool(
    tool: string,
    args: string[],
    files: HostToolFile[],
): Promise<HostToolResult | null> {
    if (!hostToolsEnabled()) return null;
    try {
        const res = await fetch(`http://localhost:${SIDECAR_PORT}/tool/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tool,
                args,
                files: files.map((f) => ({ name: f.name, base64: toBase64(f.bytes) })),
            }),
        });
        const body = await res.json() as {
            ok?: boolean; error?: string; exitCode?: number; stdout?: string; stderr?: string;
            outputs?: Array<{ name: string; base64: string }>;
        };
        if (!res.ok || !body.ok) {
            Logger.warn(LogCategory.SYSTEM,
                `[HOSTTOOL] ${tool}: sidecar refused (${res.status}) — ${body.error ?? "no reason given"}`);
            return null;
        }
        return {
            exitCode: body.exitCode ?? 0,
            stdout: body.stdout ?? "",
            stderr: body.stderr ?? "",
            outputs: (body.outputs ?? []).map((o) => ({ name: o.name, bytes: fromBase64(o.base64) })),
        };
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `[HOSTTOOL] ${tool}: sidecar unreachable — ${(e as Error).message}`);
        return null;
    }
}
