import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

interface WidePathHost {
    readWString(ptr: number, maxChars: number): string;
    writeWString(ptr: number, value: string): void;
    malloc(bytes: number): number;
    setErrno(code: number): void;
}

function fullPath(path: string, cwd: string): string {
    let value = path.replace(/\//g, "\\");
    cwd = cwd.replace(/\//g, "\\");
    if (!value) value = cwd;
    else if (!value.startsWith("\\\\")) {
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
    // A UNC server/share is the root, not two ordinary directories that '..' can pop.
    const unc = value.startsWith("\\\\");
    const parts = value.split("\\").filter(Boolean);
    const floor = unc ? 2 : 1;
    const normalized: string[] = [];
    for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") { if (normalized.length > floor) normalized.pop(); }
        else normalized.push(part);
    }
    let result = (unc ? "\\\\" : "") + normalized.join("\\");
    if (/^[a-z]:$/i.test(result)) result += "\\";
    return result;
}

export function registerCrtWidePathExports(exports: Record<string, ThunkImplementation>, host: WidePathHost): void {
    const read = (ptr: number): string => ptr ? host.readWString(ptr, 32768) : "";
    const error = (code: number): number => { host.setErrno(code); return code; };
    exports["_wfullpath"] = (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0, size = (a[2] ?? 0) >>> 0;
        if (dst && size === 0) { error(22); return 0; }
        const result = fullPath(read((a[1] ?? 0) >>> 0), System.getInstance().fileSystem.currentDir || "C:\\");
        if (dst && result.length >= size) { Mem.writeUint16(dst, 0); error(34); return 0; }
        const out = dst || host.malloc((result.length + 1) * 2);
        if (!out) { error(12); return 0; }
        host.writeWString(out, result);
        return out >>> 0;
    };
    exports["_wmakepath_s"] = (_c, _m, a) => {
        const dst = (a[0] ?? 0) >>> 0, size = (a[1] ?? 0) >>> 0;
        if (!dst || !size) return error(22);
        const drive = read((a[2] ?? 0) >>> 0), dir = read((a[3] ?? 0) >>> 0);
        const name = read((a[4] ?? 0) >>> 0), ext = read((a[5] ?? 0) >>> 0);
        const result = (drive ? drive[0] + ":" : "") + dir +
            (dir && !/[\\/]$/.test(dir) ? "\\" : "") + name + (ext && ext[0] !== "." ? "." : "") + ext;
        if (result.length >= size) { Mem.writeUint16(dst, 0); return error(34); }
        host.writeWString(dst, result);
        return 0;
    };
    exports["_wsplitpath_s"] = (_c, _m, a) => {
        const clear = (): void => {
            for (let i = 1; i < 9; i += 2) if (a[i] && a[i + 1]) Mem.writeUint16(a[i]! >>> 0, 0);
        };
        for (let i = 1; i < 9; i += 2) {
            if (!(a[i] ?? 0) !== !(a[i + 1] ?? 0)) { clear(); return error(22); }
        }
        if (!a[0]) { clear(); return error(22); }
        let path = read(a[0] >>> 0);
        const drive = path.length >= 2 && path[1] === ":" ? path.slice(0, 2) : "";
        path = path.slice(drive.length);
        const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
        const dir = path.slice(0, slash + 1), file = path.slice(slash + 1);
        const dot = file.lastIndexOf(".");
        const parts = [drive, dir, dot < 0 ? file : file.slice(0, dot), dot < 0 ? "" : file.slice(dot)];
        for (let i = 0; i < 4; i++) {
            if (a[1 + i * 2] && parts[i]!.length >= (a[2 + i * 2]! >>> 0)) { clear(); return error(34); }
        }
        for (let i = 0; i < 4; i++) if (a[1 + i * 2]) host.writeWString(a[1 + i * 2]! >>> 0, parts[i]!);
        return 0;
    };
}
