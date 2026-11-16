import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { raiseGuestAccessViolation } from "../core/thunking/guest-fault";
import type { ThunkResult, ThunkImplementation } from "../core/thunking/thunk-dispatcher";

import {readCrtWString, withCrtReadFault} from "./crt-checked-strings";

interface WidePathHost {
    malloc(bytes: number): number;
    setErrno(code: number): void;
}

function writePath(ctx: {esp: number}, mem: Uint8Array, dst: number, text: string): ThunkResult | undefined {
    for (let i = 0; i <= text.length; i++) {
        const address = dst + i * 2;
        if (!Mem.writeUint16(address, i === text.length ? 0 : text.charCodeAt(i))) {
            return raiseGuestAccessViolation(ctx, mem, Mem.firstInaccessibleByte(address, 2, "w"), "w", 0);
        }
    }
}

function fullPath(path: string, cwd: string): string {
    let value = path.replace(/\//g, "\\");
    const trailingSeparator = /[\\/]$/.test(path);
    // Keep device namespace roots separate from ordinary UNC server/share roots.
    let prefix = /^\\\\[?.]\\/.exec(value)?.[0] ?? "";
    if (prefix) value = value.slice(prefix.length);
    const namespaceUnc = !!prefix && /^UNC\\/i.test(value);
    if (namespaceUnc) { prefix += value.slice(0, 4); value = "\\\\" + value.slice(4); }
    cwd = cwd.replace(/\//g, "\\");
    if (!value) value = cwd;
    else if (!prefix && !value.startsWith("\\\\")) {
        const drive = /^([a-z]):/i.exec(value);
        if (drive) {
            if (value[2] !== "\\") {
                const base = cwd.slice(0, 2).toLowerCase() === drive[0].toLowerCase() ? cwd : drive[0] + "\\";
                value = base.replace(/\\*$/, "\\") + value.slice(2);
            }
        } else if (value.startsWith("\\")) {
            value = cwd.slice(0, 2) + value;
        } else value = cwd.replace(/\\*$/, "\\") + value;
    }
    const unc = value.startsWith("\\\\");
    const parts = value.split("\\").filter(Boolean);
    const floor = unc ? 2 : 1;
    const normalized: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i]!;
        if (part === ".") continue;
        if (part === "..") { if (normalized.length > floor) normalized.pop(); }
        else {
            // Intermediate components lose a single final dot, but keep final spaces.
            if ((i < parts.length - 1 || trailingSeparator) && /[^.]\.$/.test(part)) part = part.slice(0, -1);
            normalized.push(part);
        }
    }
    if (!trailingSeparator && normalized.length > floor) {
        normalized[normalized.length - 1] = normalized[normalized.length - 1]!.replace(/[. ]+$/, "");
    }
    let result = prefix + (unc && !namespaceUnc ? "\\\\" : "") + normalized.join("\\");
    if (/^[a-z]:$/i.test(result.slice(prefix.length)) || (trailingSeparator && !result.endsWith("\\"))) result += "\\";
    return result;
}

export function registerCrtWidePathExports(exports: Record<string, ThunkImplementation>, host: WidePathHost): void {
    const read = (ptr: number): string => ptr ? readCrtWString(ptr, 32768) : "";
    const error = (code: number): number => { host.setErrno(code); return code; };
    exports["_wfullpath"] = withCrtReadFault((ctx, mem, a) => {
        const dst = (a[0] ?? 0) >>> 0, size = (a[2] ?? 0) >>> 0;
        if (dst && size === 0) { error(22); return 0; }
        const result = fullPath(read((a[1] ?? 0) >>> 0), System.getInstance().fileSystem.currentDir || "C:\\");
        if (dst && result.length >= size) {
            const fault = writePath(ctx, mem, dst, "");
            if (fault) return fault;
            error(34); return 0;
        }
        const out = dst || host.malloc((result.length + 1) * 2);
        if (!out) { error(12); return 0; }
        const fault = writePath(ctx, mem, out, result);
        if (fault) return fault;
        return out >>> 0;
    });
    exports["_wmakepath_s"] = withCrtReadFault((ctx, mem, a) => {
        const dst = (a[0] ?? 0) >>> 0, size = (a[1] ?? 0) >>> 0;
        if (!dst || !size) return error(22);
        const drive = read((a[2] ?? 0) >>> 0), dir = read((a[3] ?? 0) >>> 0);
        const name = read((a[4] ?? 0) >>> 0), ext = read((a[5] ?? 0) >>> 0);
        const result = (drive ? drive[0] + ":" : "") + dir +
            (dir && !/[\\/]$/.test(dir) ? "\\" : "") + name + (ext && ext[0] !== "." ? "." : "") + ext;
        if (result.length >= size) {
            const fault = writePath(ctx, mem, dst, "");
            if (fault) return fault;
            return error(34);
        }
        const fault = writePath(ctx, mem, dst, result);
        if (fault) return fault;
        return 0;
    });
    exports["_wsplitpath_s"] = withCrtReadFault((ctx, mem, a) => {
        const clear = (): ThunkResult | undefined => {
            for (let i = 1; i < 9; i += 2) if (a[i] && a[i + 1]) {
                const fault = writePath(ctx, mem, a[i]! >>> 0, "");
                if (fault) return fault;
            }
        };
        for (let i = 1; i < 9; i += 2) {
            if (!(a[i] ?? 0) !== !(a[i + 1] ?? 0)) {
                const fault = clear();
                if (fault) return fault;
                return error(22);
            }
        }
        if (!a[0]) {
            const fault = clear();
            if (fault) return fault;
            return error(22);
        }
        let path = read(a[0] >>> 0);
        const drive = path.length >= 2 && path[1] === ":" ? path.slice(0, 2) : "";
        path = path.slice(drive.length);
        const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
        const dir = path.slice(0, slash + 1), file = path.slice(slash + 1);
        const dot = file.lastIndexOf(".");
        const parts = [drive, dir, dot < 0 ? file : file.slice(0, dot), dot < 0 ? "" : file.slice(dot)];
        for (let i = 0; i < 4; i++) {
            if (a[1 + i * 2] && parts[i]!.length >= (a[2 + i * 2]! >>> 0)) {
                const fault = clear();
                if (fault) return fault;
                return error(34);
            }
        }
        for (let i = 0; i < 4; i++) if (a[1 + i * 2]) {
            const fault = writePath(ctx, mem, a[1 + i * 2]! >>> 0, parts[i]!);
            if (fault) return fault;
        }
        return 0;
    });
}
