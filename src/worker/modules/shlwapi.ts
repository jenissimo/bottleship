import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { encodeAnsi, getCodePageDecoder } from "./codepage-utils";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { System } from "../core/system";

const MAX_PATH = 260;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;

export class Shlwapi implements IModule {
    name = "shlwapi";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        const bindA = (name: string, fn: (args: number[]) => number, stackCleanup: number) => {
            this.exports[name] = (_ctx, _mem, args) => ({ value: fn(args), stackCleanup });
        };

        bindA("PathFindFileNameA", (args) => this.findFileNameAnsi(args[0] >>> 0), 4);
        bindA("PathFindFileNameW", (args) => this.findFileNameWide(args[0] >>> 0), 4);
        bindA("PathFindExtensionA", (args) => this.findExtensionAnsi(args[0] >>> 0), 4);
        bindA("PathFindExtensionW", (args) => this.findExtensionWide(args[0] >>> 0), 4);

        bindA("PathAppendA", (args) => this.pathAppendA(args[0] >>> 0, args[1] >>> 0) ? 1 : 0, 8);
        bindA("PathAppendW", (args) => this.pathAppendW(args[0] >>> 0, args[1] >>> 0) ? 1 : 0, 8);

        bindA("PathCombineA", (args) => this.pathCombineA(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0), 12);
        bindA("PathCombineW", (args) => this.pathCombineW(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0), 12);

        bindA("PathCanonicalizeA", (args) => this.pathCanonicalizeA(args[0] >>> 0, args[1] >>> 0) ? 1 : 0, 8);
        bindA("PathCanonicalizeW", (args) => this.pathCanonicalizeW(args[0] >>> 0, args[1] >>> 0) ? 1 : 0, 8);

        bindA("PathAddBackslashA", (args) => this.pathAddBackslashA(args[0] >>> 0), 4);
        bindA("PathAddBackslashW", (args) => this.pathAddBackslashW(args[0] >>> 0), 4);

        bindA("PathRemoveFileSpecA", (args) => this.pathRemoveFileSpecA(args[0] >>> 0) ? 1 : 0, 4);
        bindA("PathRemoveFileSpecW", (args) => this.pathRemoveFileSpecW(args[0] >>> 0) ? 1 : 0, 4);
        bindA("PathStripToRootA", (args) => this.pathStripToRootA(args[0] >>> 0) ? 1 : 0, 4);
        bindA("PathStripToRootW", (args) => this.pathStripToRootW(args[0] >>> 0) ? 1 : 0, 4);
        bindA("PathIsUNCA", (args) => this.isUncPath(this.readAnsi(args[0] >>> 0)) ? 1 : 0, 4);
        bindA("PathIsUNCW", (args) => this.isUncPath(this.readWide(args[0] >>> 0)) ? 1 : 0, 4);
        bindA("PathIsDirectoryA", (args) => this.pathIsDirectoryA(args[0] >>> 0) ? 1 : 0, 4);
        bindA("PathIsDirectoryW", (args) => this.pathIsDirectoryW(args[0] >>> 0) ? 1 : 0, 4);
        bindA("PathFileExistsA", (args) => this.pathFileExistsA(args[0] >>> 0) ? 1 : 0, 4);
        bindA("PathFileExistsW", (args) => this.pathFileExistsW(args[0] >>> 0) ? 1 : 0, 4);

        bindA("PathSkipRootA", (args) => this.pathSkipRootA(args[0] >>> 0), 4);
        bindA("PathSkipRootW", (args) => this.pathSkipRootW(args[0] >>> 0), 4);

        bindA(
            "PathRelativePathToA",
            (args) =>
                this.pathRelativePathToA(
                    args[0] >>> 0,
                    args[1] >>> 0,
                    args[2] >>> 0,
                    args[3] >>> 0,
                    args[4] >>> 0
                )
                    ? 1
                    : 0,
            20
        );
        bindA(
            "PathRelativePathToW",
            (args) =>
                this.pathRelativePathToW(
                    args[0] >>> 0,
                    args[1] >>> 0,
                    args[2] >>> 0,
                    args[3] >>> 0,
                    args[4] >>> 0
                )
                    ? 1
                    : 0,
            20
        );

        bindA("PathRemoveExtensionA", (args) => { this.pathRemoveExtensionA(args[0] >>> 0); return 0; }, 4);
        bindA("PathRemoveExtensionW", (args) => { this.pathRemoveExtensionW(args[0] >>> 0); return 0; }, 4);

        bindA("UrlUnescapeA", (args) => this.urlUnescapeA(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0), 16);
        bindA("UrlUnescapeW", (args) => this.urlUnescapeW(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0), 16);

        bindA("PathMatchSpecA", (args) => this.pathMatchSpec(this.readAnsi(args[0] >>> 0), this.readAnsi(args[1] >>> 0)) ? 1 : 0, 8);
        bindA("PathMatchSpecW", (args) => this.pathMatchSpec(this.readWide(args[0] >>> 0), this.readWide(args[1] >>> 0)) ? 1 : 0, 8);

        // HLS<->RGB use the Win32 convention: H/L/S each 0..240 (HLSMAX=240), R/G/B 0..255.
        bindA("ColorHLSToRGB", (args) => this.colorHlsToRgb(args[0] & 0xffff, args[1] & 0xffff, args[2] & 0xffff), 12);
        bindA("ColorRGBToHLS", (args) => { this.colorRgbToHls(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0); return 0; }, 16);
    }

    reset(): void {}

    /** PathMatchSpec: TRUE if `name` matches `spec`. `spec` is a ';'-separated list of
     *  wildcard patterns (`*` any run, `?` any single char), case-insensitive. `*` and
     *  `*.*` match everything (DOS/shell semantics). */
    private pathMatchSpec(name: string, spec: string): boolean {
        for (const part of spec.split(";")) {
            if (this.matchSingleSpec(name, part.trim())) return true;
        }
        return false;
    }

    private matchSingleSpec(name: string, spec: string): boolean {
        if (spec === "") return false;
        if (spec === "*" || spec === "*.*") return true;
        let re = "^";
        for (const ch of spec) {
            if (ch === "*") re += ".*";
            else if (ch === "?") re += ".";
            else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
        re += "$";
        try { return new RegExp(re, "i").test(name); } catch { return false; }
    }

    // HLSMAX=240, RGBMAX=255, UNDEFINED-hue = HLSMAX*2/3. Byte-exact port of the Win32
    // ColorRGBToHLS/ColorHLSToRGB integer algorithm (same one in comctl32/Wine).
    private colorRgbToHls(clrRGB: number, pwHue: number, pwLum: number, pwSat: number): void {
        const HLSMAX = 240, RGBMAX = 255, UNDEFINED = (HLSMAX * 2 / 3) | 0;
        const R = clrRGB & 0xff, G = (clrRGB >>> 8) & 0xff, B = (clrRGB >>> 16) & 0xff;
        const cMax = Math.max(R, G, B), cMin = Math.min(R, G, B);
        const L = (((cMax + cMin) * HLSMAX + RGBMAX) / (2 * RGBMAX)) | 0;
        let H: number, S: number;
        if (cMax === cMin) {
            S = 0;
            H = UNDEFINED;
        } else {
            if (L <= HLSMAX / 2) S = (((cMax - cMin) * HLSMAX + ((cMax + cMin) >> 1)) / (cMax + cMin)) | 0;
            else S = (((cMax - cMin) * HLSMAX + ((2 * RGBMAX - cMax - cMin) >> 1)) / (2 * RGBMAX - cMax - cMin)) | 0;
            const Rdelta = (((cMax - R) * (HLSMAX / 6) + ((cMax - cMin) >> 1)) / (cMax - cMin)) | 0;
            const Gdelta = (((cMax - G) * (HLSMAX / 6) + ((cMax - cMin) >> 1)) / (cMax - cMin)) | 0;
            const Bdelta = (((cMax - B) * (HLSMAX / 6) + ((cMax - cMin) >> 1)) / (cMax - cMin)) | 0;
            if (R === cMax) H = Bdelta - Gdelta;
            else if (G === cMax) H = ((HLSMAX / 3) | 0) + Rdelta - Bdelta;
            else H = ((2 * HLSMAX / 3) | 0) + Gdelta - Rdelta;
            if (H < 0) H += HLSMAX;
            if (H > HLSMAX) H -= HLSMAX;
        }
        if (pwHue) Mem.writeUint16(pwHue, H & 0xffff);
        if (pwLum) Mem.writeUint16(pwLum, L & 0xffff);
        if (pwSat) Mem.writeUint16(pwSat, S & 0xffff);
    }

    private colorHlsToRgb(H: number, L: number, S: number): number {
        const HLSMAX = 240, RGBMAX = 255;
        const hueToRgb = (n1: number, n2: number, hue: number): number => {
            if (hue < 0) hue += HLSMAX;
            if (hue > HLSMAX) hue -= HLSMAX;
            if (hue < HLSMAX / 6) return n1 + (((n2 - n1) * hue + (HLSMAX / 12)) / (HLSMAX / 6));
            if (hue < HLSMAX / 2) return n2;
            if (hue < HLSMAX * 2 / 3) return n1 + (((n2 - n1) * ((HLSMAX * 2 / 3) - hue) + (HLSMAX / 12)) / (HLSMAX / 6));
            return n1;
        };
        let R: number, G: number, B: number;
        if (S === 0) {
            R = G = B = ((L * RGBMAX) / HLSMAX) | 0;
        } else {
            let Magic2: number;
            if (L <= HLSMAX / 2) Magic2 = ((L * (HLSMAX + S) + (HLSMAX / 2)) / HLSMAX) | 0;
            else Magic2 = L + S - (((L * S) + (HLSMAX / 2)) / HLSMAX | 0);
            const Magic1 = 2 * L - Magic2;
            R = Math.min(RGBMAX, ((hueToRgb(Magic1, Magic2, H + ((HLSMAX / 3) | 0)) * RGBMAX + (HLSMAX / 2)) / HLSMAX) | 0);
            G = Math.min(RGBMAX, ((hueToRgb(Magic1, Magic2, H) * RGBMAX + (HLSMAX / 2)) / HLSMAX) | 0);
            B = Math.min(RGBMAX, ((hueToRgb(Magic1, Magic2, H - ((HLSMAX / 3) | 0)) * RGBMAX + (HLSMAX / 2)) / HLSMAX) | 0);
        }
        return ((B & 0xff) << 16) | ((G & 0xff) << 8) | (R & 0xff);
    }

    private readAnsi(ptr: number, maxLen: number = MAX_PATH): string {
        if (!ptr) return "";
        const bytes: number[] = [];
        for (let i = 0; i < maxLen; i++) {
            const b = Mem.readUint8(ptr + i);
            if (b === null || b === 0) break;
            bytes.push(b);
        }
        return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(new Uint8Array(bytes));
    }

    private writeAnsi(ptr: number, value: string, maxLen: number = MAX_PATH): boolean {
        if (!ptr) return false;
        const encoded = encodeAnsi(value);
        if (encoded.length >= maxLen) return false;
        const bytes = new Uint8Array(encoded.length + 1);
        bytes.set(encoded);
        Mem.writeBytes(ptr, bytes);
        return true;
    }

    private readWide(ptr: number, maxChars: number = MAX_PATH): string {
        if (!ptr) return "";
        const codes: number[] = [];
        for (let i = 0; i < maxChars; i++) {
            const ch = Mem.readUint16(ptr + i * 2);
            if (ch === null || ch === 0) break;
            codes.push(ch);
        }
        return String.fromCharCode(...codes);
    }

    private writeWide(ptr: number, value: string, maxChars: number = MAX_PATH): boolean {
        if (!ptr) return false;
        if (value.length >= maxChars) return false;
        const bytes = new Uint8Array((value.length + 1) * 2);
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            bytes[i * 2] = code & 0xff;
            bytes[i * 2 + 1] = (code >>> 8) & 0xff;
        }
        Mem.writeBytes(ptr, bytes);
        return true;
    }

    private normalizeSlashes(path: string): string {
        return path.replace(/\//g, "\\");
    }

    private splitRoot(path: string): { root: string; rest: string } {
        path = this.normalizeSlashes(path);
        if (path.startsWith("\\\\")) {
            const parts = path.split("\\").filter((p) => p.length > 0);
            if (parts.length >= 2) {
                const root = `\\\\${parts[0]}\\${parts[1]}`;
                const rest = parts.slice(2).join("\\");
                return { root, rest };
            }
            return { root: path, rest: "" };
        }
        if (path.length >= 2 && path[1] === ":") {
            const root = path.substring(0, 2);
            let rest = path.substring(2);
            if (rest.startsWith("\\")) rest = rest.substring(1);
            return { root, rest };
        }
        if (path.startsWith("\\")) {
            return { root: "\\", rest: path.substring(1) };
        }
        return { root: "", rest: path };
    }

    private isAbsolutePath(path: string): boolean {
        const { root } = this.splitRoot(path);
        return root.length > 0;
    }

    private isSameRoot(a: string, b: string): boolean {
        const ra = this.splitRoot(a);
        const rb = this.splitRoot(b);
        return ra.root.toLowerCase() === rb.root.toLowerCase();
    }

    private canonicalizePath(path: string): string {
        path = this.normalizeSlashes(path);
        // PathCanonicalize only rewrites "." and "..": it copies every other character
        // through, so a TRAILING separator survives. Dropping it turns a caller's
        // `PathCombine(dst, dir, L"Launcher\\")` + `strcat(dst, L"file")` into
        // `C:\Launcherfile` — a path that exists nowhere, reported only as "file not found".
        const trailing = path.length > 1 && path.endsWith("\\");
        const { root, rest } = this.splitRoot(path);
        const segments = rest.split("\\").filter((s) => s.length > 0);
        const stack: string[] = [];

        for (const seg of segments) {
            if (seg === ".") continue;
            if (seg === "..") {
                if (stack.length > 0 && stack[stack.length - 1] !== "..") {
                    stack.pop();
                } else if (!root) {
                    stack.push("..");
                }
            } else {
                stack.push(seg);
            }
        }

        let result = root;
        if (stack.length > 0) {
            if (root) {
                if (root === "\\" || (root.length === 2 && root[1] === ":")) {
                    result += "\\";
                } else if (!root.endsWith("\\")) {
                    result += "\\";
                }
            }
            result += stack.join("\\");
        } else if (root.length === 2 && root[1] === ":") {
            result += "\\";
        }

        if (trailing && !result.endsWith("\\")) result += "\\";
        return result;
    }

    private joinPath(base: string, more: string): string {
        base = this.normalizeSlashes(base);
        more = this.normalizeSlashes(more);

        if (!more) return base;
        if (!base) return this.canonicalizePath(more);
        if (this.isAbsolutePath(more)) return this.canonicalizePath(more);

        // PathAppend strips leading "." / ".." navigation from the base path.
        while (base.startsWith("..\\")) {
            base = base.substring(3);
        }
        if (base.startsWith(".\\")) {
            base = base.substring(2);
        }

        const needsSlash = !base.endsWith("\\") && !more.startsWith("\\");
        const joined = needsSlash ? `${base}\\${more}` : `${base}${more}`;
        return this.canonicalizePath(joined);
    }

    private pathAppendA(pathPtr: number, morePtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.readAnsi(pathPtr);
        const more = this.readAnsi(morePtr);
        const result = this.joinPath(path, more);
        if (result.length >= MAX_PATH) return false;
        return this.writeAnsi(pathPtr, result);
    }

    private pathAppendW(pathPtr: number, morePtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.readWide(pathPtr);
        const more = this.readWide(morePtr);
        const result = this.joinPath(path, more);
        if (result.length >= MAX_PATH) return false;
        return this.writeWide(pathPtr, result);
    }

    /** PathIsRelative: anything that neither starts at a root nor names a drive. */
    private isRelativePath(path: string): boolean {
        if (!path) return true;
        return !(path[0] === "\\" || path[1] === ":");
    }

    /**
     * PathCombine's rules are NOT PathAppend's, and the difference is load-bearing: a `file`
     * that names a drive replaces `dir` outright, while one that merely STARTS with a
     * backslash keeps only `dir`'s root. `null` is the caller-visible failure — the API
     * reports it by writing an empty destination and returning NULL.
     */
    private combinePath(dir: string | null, file: string | null): string | null {
        if (dir === null && file === null) return null;

        let tmp: string;
        if ((file === null || file === "") && dir !== null) {
            tmp = dir;
        } else if (dir === null || dir === "" || !this.isRelativePath(file!)) {
            if (dir === null || dir === "" || file![0] !== "\\" || this.isUncPath(file!)) {
                tmp = file!;
            } else {
                const root = this.stripRootValue(dir);
                if (root === null) return null;
                tmp = this.appendBackslash(root);
                if (tmp.length + file!.length - 1 >= MAX_PATH) return null;
                tmp += file!.substring(1);
            }
        } else {
            tmp = this.appendBackslash(dir);
            if (tmp.length + file!.length >= MAX_PATH) return null;
            tmp += file!;
        }

        return this.canonicalizePath(tmp);
    }

    /** PathAddBackslash on a value rather than a buffer. */
    private appendBackslash(path: string): string {
        return path === "" || path.endsWith("\\") ? path : `${path}\\`;
    }

    private pathCombineA(destPtr: number, dirPtr: number, filePtr: number): number {
        if (!destPtr) return 0;
        const result = this.combinePath(
            dirPtr ? this.readAnsi(dirPtr) : null,
            filePtr ? this.readAnsi(filePtr) : null,
        );
        if (result === null || !this.writeAnsi(destPtr, result)) {
            this.writeAnsi(destPtr, "");
            return 0;
        }
        return destPtr;
    }

    private pathCombineW(destPtr: number, dirPtr: number, filePtr: number): number {
        if (!destPtr) return 0;
        const result = this.combinePath(
            dirPtr ? this.readWide(dirPtr) : null,
            filePtr ? this.readWide(filePtr) : null,
        );
        if (result === null || !this.writeWide(destPtr, result)) {
            this.writeWide(destPtr, "");
            return 0;
        }
        return destPtr;
    }

    private pathCanonicalizeA(destPtr: number, srcPtr: number): boolean {
        if (!destPtr || !srcPtr) return false;
        const result = this.canonicalizePath(this.readAnsi(srcPtr));
        if (result.length >= MAX_PATH) return false;
        return this.writeAnsi(destPtr, result);
    }

    private pathCanonicalizeW(destPtr: number, srcPtr: number): boolean {
        if (!destPtr || !srcPtr) return false;
        const result = this.canonicalizePath(this.readWide(srcPtr));
        if (result.length >= MAX_PATH) return false;
        return this.writeWide(destPtr, result);
    }

    private pathAddBackslashA(pathPtr: number): number {
        if (!pathPtr) return 0;
        let path = this.readAnsi(pathPtr);
        if (!path) return pathPtr;
        if (path.endsWith("\\")) {
            return (pathPtr + this.strlenA(pathPtr)) >>> 0;
        }
        if (path.length >= MAX_PATH - 1) return pathPtr;
        path += "\\";
        if (!this.writeAnsi(pathPtr, path)) return pathPtr;
        return (pathPtr + path.length) >>> 0;
    }

    private pathAddBackslashW(pathPtr: number): number {
        if (!pathPtr) return 0;
        let path = this.readWide(pathPtr);
        if (!path) return pathPtr;
        if (path.endsWith("\\")) {
            return (pathPtr + this.strlenW(pathPtr) * 2) >>> 0;
        }
        if (path.length >= MAX_PATH - 1) return pathPtr;
        path += "\\";
        if (!this.writeWide(pathPtr, path)) return pathPtr;
        return (pathPtr + path.length * 2) >>> 0;
    }

    private pathRemoveFileSpecA(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.normalizeSlashes(this.readAnsi(pathPtr));
        const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
        if (slash < 0) {
            this.writeAnsi(pathPtr, "");
            return false;
        }
        const result = path.substring(0, slash);
        const finalPath = result.length === 2 && result[1] === ":" ? `${result}\\` : result;
        this.writeAnsi(pathPtr, finalPath);
        return true;
    }

    private pathRemoveFileSpecW(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.normalizeSlashes(this.readWide(pathPtr));
        const slash = path.lastIndexOf("\\");
        if (slash < 0) {
            this.writeWide(pathPtr, "");
            return false;
        }
        const result = path.substring(0, slash);
        const finalPath = result.length === 2 && result[1] === ":" ? `${result}\\` : result;
        this.writeWide(pathPtr, finalPath);
        return true;
    }

    private pathStripToRootA(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const root = this.stripRootValue(this.readAnsi(pathPtr));
        if (root === null || root.length >= MAX_PATH) return false;
        return this.writeAnsi(pathPtr, root);
    }

    private pathStripToRootW(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const root = this.stripRootValue(this.readWide(pathPtr));
        if (root === null || root.length >= MAX_PATH) return false;
        return this.writeWide(pathPtr, root);
    }

    private stripRootValue(path: string): string | null {
        path = this.normalizeSlashes(path);
        if (!path) return null;

        if (path.startsWith("\\\\")) {
            let i = 2;
            let components = 0;
            while (i < path.length && components < 2) {
                while (i < path.length && path[i] === "\\") i++;
                if (i >= path.length) break;
                while (i < path.length && path[i] !== "\\") i++;
                components++;
            }
            if (components < 2) return null;
            return `${path.slice(0, i).replace(/\\+$/, "")}\\`;
        }

        if (path.length >= 3 && path[1] === ":" && path[2] === "\\") {
            return path.slice(0, 3);
        }

        if (path.length === 2 && path[1] === ":") {
            return path;
        }

        if (path.startsWith("\\")) {
            return "\\";
        }

        return null;
    }

    private pathIsDirectoryA(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.readAnsi(pathPtr);
        if (!path) return false;
        const vfs = System.getInstance().fileSystem;
        return vfs.directoryExists(vfs.resolvePath(path));
    }

    private pathIsDirectoryW(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.readWide(pathPtr);
        if (!path) return false;
        const vfs = System.getInstance().fileSystem;
        return vfs.directoryExists(vfs.resolvePath(path));
    }

    private pathFileExistsA(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.readAnsi(pathPtr);
        if (!path) return false;
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        return vfs.fileExists(resolved) || vfs.directoryExists(resolved);
    }

    private pathFileExistsW(pathPtr: number): boolean {
        if (!pathPtr) return false;
        const path = this.readWide(pathPtr);
        if (!path) return false;
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        return vfs.fileExists(resolved) || vfs.directoryExists(resolved);
    }

    private isUncPath(path: string): boolean {
        path = this.normalizeSlashes(path);
        if (!path.startsWith("\\\\")) return false;
        const lower = path.toLowerCase();
        if (lower.startsWith("\\\\?\\unc\\")) return true;
        if (lower.startsWith("\\\\.\\") || lower.startsWith("\\\\?\\")) return false;
        return path.length > 2 && path[2] !== "\\";
    }

    private pathSkipRootA(pathPtr: number): number {
        if (!pathPtr) return 0;
        const path = this.readAnsi(pathPtr);
        const offset = this.skipRootOffset(path);
        return offset > 0 ? (pathPtr + offset) >>> 0 : 0;
    }

    private pathSkipRootW(pathPtr: number): number {
        if (!pathPtr) return 0;
        const path = this.readWide(pathPtr);
        const offset = this.skipRootOffset(path);
        return offset > 0 ? (pathPtr + offset * 2) >>> 0 : 0;
    }

    private skipRootOffset(path: string): number {
        path = this.normalizeSlashes(path);
        if (path.length >= 3 && path[1] === ":" && path[2] === "\\") {
            return 3;
        }
        if (path.startsWith("\\\\")) {
            let i = 2;
            let components = 0;
            while (i < path.length && components < 2) {
                while (i < path.length && path[i] === "\\") i++;
                if (i >= path.length) break;
                while (i < path.length && path[i] !== "\\") i++;
                components++;
            }
            while (i < path.length && path[i] === "\\") i++;
            return i;
        }
        return 0;
    }

    private pathRelativePathToA(
        destPtr: number,
        fromPtr: number,
        toPtr: number,
        attrFrom: number,
        attrTo: number
    ): boolean {
        if (!destPtr || !fromPtr || !toPtr) return false;
        const from = this.canonicalizePath(this.readAnsi(fromPtr));
        const to = this.canonicalizePath(this.readAnsi(toPtr));
        const result = this.buildRelativePath(from, to, attrFrom, attrTo);
        if (!result || result.length >= MAX_PATH) return false;
        return this.writeAnsi(destPtr, result);
    }

    private pathRelativePathToW(
        destPtr: number,
        fromPtr: number,
        toPtr: number,
        attrFrom: number,
        attrTo: number
    ): boolean {
        if (!destPtr || !fromPtr || !toPtr) return false;
        const from = this.canonicalizePath(this.readWide(fromPtr));
        const to = this.canonicalizePath(this.readWide(toPtr));
        const result = this.buildRelativePath(from, to, attrFrom, attrTo);
        if (!result || result.length >= MAX_PATH) return false;
        return this.writeWide(destPtr, result);
    }

    private buildRelativePath(from: string, to: string, attrFrom: number, attrTo: number): string | null {
        if (!this.isAbsolutePath(from) || !this.isAbsolutePath(to)) return null;
        if (!this.isSameRoot(from, to)) return null;

        let fromDir = from;
        let toDir = to;
        const fromIsDir = (attrFrom & FILE_ATTRIBUTE_DIRECTORY) !== 0;
        const toIsDir = (attrTo & FILE_ATTRIBUTE_DIRECTORY) !== 0;

        if (!fromIsDir) {
            const slash = fromDir.lastIndexOf("\\");
            fromDir = slash >= 0 ? fromDir.substring(0, slash) : fromDir;
        }
        if (!toIsDir) {
            const slash = toDir.lastIndexOf("\\");
            toDir = slash >= 0 ? toDir.substring(0, slash) : toDir;
        }

        const fromParts = this.splitRoot(fromDir).rest.split("\\").filter((p) => p.length > 0);
        const toParts = this.splitRoot(toDir).rest.split("\\").filter((p) => p.length > 0);

        let common = 0;
        while (
            common < fromParts.length &&
            common < toParts.length &&
            fromParts[common].toLowerCase() === toParts[common].toLowerCase()
        ) {
            common++;
        }

        const up = Array.from({ length: fromParts.length - common }, () => "..");
        const down = toParts.slice(common);
        let relative = [...up, ...down].join("\\");

        if (!toIsDir) {
            const fileName = to.substring(to.lastIndexOf("\\") + 1);
            relative = relative ? `${relative}\\${fileName}` : fileName;
        }

        return relative || ".";
    }

    private strlenA(ptr: number): number {
        let len = 0;
        while (len < MAX_PATH) {
            const b = Mem.readUint8(ptr + len);
            if (b === null || b === 0) break;
            len++;
        }
        return len;
    }

    private strlenW(ptr: number): number {
        let len = 0;
        while (len < MAX_PATH) {
            const ch = Mem.readUint16(ptr + len * 2);
            if (ch === null || ch === 0) break;
            len++;
        }
        return len;
    }

    private findFileNameAnsi(pathPtr: number): number {
        if (!pathPtr) return 0;

        let cursor = pathPtr >>> 0;
        let result = cursor;

        while (true) {
            const ch = Mem.readUint8(cursor);
            if (ch === null || ch === 0) {
                return result >>> 0;
            }

            if (ch === 0x5c || ch === 0x2f || ch === 0x3a) {
                result = (cursor + 1) >>> 0;
            }

            cursor = (cursor + 1) >>> 0;
        }
    }

    private findFileNameWide(pathPtr: number): number {
        if (!pathPtr) return 0;

        let cursor = pathPtr >>> 0;
        let result = cursor;

        while (true) {
            const ch = Mem.readUint16(cursor);
            if (ch === null || ch === 0) {
                return result >>> 0;
            }

            if (ch === 0x5c || ch === 0x2f || ch === 0x3a) {
                result = (cursor + 2) >>> 0;
            }

            cursor = (cursor + 2) >>> 0;
        }
    }

    private findExtensionAnsi(pathPtr: number): number {
        if (!pathPtr) return 0;

        let cursor = pathPtr >>> 0;
        let dot = 0;

        while (true) {
            const ch = Mem.readUint8(cursor);
            if (ch === null || ch === 0) {
                return (dot || cursor) >>> 0;
            }

            if (ch === 0x2e) {
                dot = cursor;
            } else if (ch === 0x5c || ch === 0x2f || ch === 0x3a) {
                dot = 0;
            }

            cursor = (cursor + 1) >>> 0;
        }
    }

    private findExtensionWide(pathPtr: number): number {
        if (!pathPtr) return 0;

        let cursor = pathPtr >>> 0;
        let dot = 0;

        while (true) {
            const ch = Mem.readUint16(cursor);
            if (ch === null || ch === 0) {
                return (dot || cursor) >>> 0;
            }

            if (ch === 0x2e) {
                dot = cursor;
            } else if (ch === 0x5c || ch === 0x2f || ch === 0x3a) {
                dot = 0;
            }

            cursor = (cursor + 2) >>> 0;
        }
    }

    // void PathRemoveExtensionA(LPSTR pszPath)
    // Finds the last '.' in the filename component and truncates there by writing a null byte.
    private pathRemoveExtensionA(pathPtr: number): void {
        if (!pathPtr) return;
        const extPtr = this.findExtensionAnsi(pathPtr);
        if (!extPtr) return;
        const ch = Mem.readUint8(extPtr);
        if (ch === 0x2e /* '.' */) {
            Mem.writeUint8(extPtr, 0);
        }
    }

    // void PathRemoveExtensionW(LPWSTR pszPath)
    private pathRemoveExtensionW(pathPtr: number): void {
        if (!pathPtr) return;
        const extPtr = this.findExtensionWide(pathPtr);
        if (!extPtr) return;
        const ch = Mem.readUint16(extPtr);
        if (ch === 0x2e /* L'.' */) {
            Mem.writeUint16(extPtr, 0);
        }
    }

    // HRESULT UrlUnescapeA(LPSTR pszUrl, LPSTR pszOut, DWORD* pcchOut, DWORD dwFlags)
    // URL_UNESCAPE_INPLACE = 0x00100000 — decode %XX sequences into pszUrl itself.
    // Otherwise decode into pszOut, updating *pcchOut with the written char count.
    private urlUnescapeA(pszUrl: number, pszOut: number, pcchOut: number, dwFlags: number): number {
        const URL_UNESCAPE_INPLACE = 0x00100000;
        const S_OK = 0;
        const E_POINTER = 0x80004003;
        const E_FAIL = 0x80004005;

        if (!pszUrl) return E_POINTER;

        // Read source, decode %XX → bytes, then interpret as Latin-1 / ANSI
        const decoded = this.decodePercentEscapes(this.readAnsi(pszUrl, 0x8000));

        if (dwFlags & URL_UNESCAPE_INPLACE) {
            return this.writeAnsi(pszUrl, decoded) ? S_OK : E_FAIL;
        }

        if (!pszOut || !pcchOut) return E_POINTER;
        const maxCch = Mem.readUint32(pcchOut);
        if (maxCch === null) return E_POINTER;
        // Buffer too small: real shlwapi writes nothing, reports the required size
        // (including the NUL) and fails — do NOT silently truncate + return S_OK.
        if (decoded.length + 1 > maxCch) {
            Mem.writeUint32(pcchOut, decoded.length + 1);
            return E_POINTER;
        }
        this.writeAnsi(pszOut, decoded);
        // On success *pcchOut receives the character count EXCLUDING the terminator.
        Mem.writeUint32(pcchOut, decoded.length);
        return S_OK;
    }

    /** Decode %XX percent-escapes; each %XX becomes one char (byte for ANSI, code unit for wide). */
    private decodePercentEscapes(src: string): string {
        let decoded = '';
        for (let i = 0; i < src.length; ) {
            if (src[i] === '%' && i + 2 < src.length) {
                const hex = src.slice(i + 1, i + 3);
                if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                    decoded += String.fromCharCode(parseInt(hex, 16));
                    i += 3;
                    continue;
                }
            }
            decoded += src[i++];
        }
        return decoded;
    }

    // HRESULT UrlUnescapeW(LPWSTR pszUrl, LPWSTR pszOut, DWORD* pcchOut, DWORD dwFlags)
    private urlUnescapeW(pszUrl: number, pszOut: number, pcchOut: number, dwFlags: number): number {
        const URL_UNESCAPE_INPLACE = 0x00100000;
        const S_OK = 0;
        const E_POINTER = 0x80004003;
        const E_FAIL = 0x80004005;

        if (!pszUrl) return E_POINTER;

        // For wide strings, %XX encodes a UTF-16 code unit byte-by-byte (two %XX sequences
        // per BMP character is the common case). Decode each %XX → charcode directly.
        const decoded = this.decodePercentEscapes(this.readWide(pszUrl, 0x8000));

        if (dwFlags & URL_UNESCAPE_INPLACE) {
            return this.writeWide(pszUrl, decoded) ? S_OK : E_FAIL;
        }

        if (!pszOut || !pcchOut) return E_POINTER;
        const maxCch = Mem.readUint32(pcchOut);
        if (maxCch === null) return E_POINTER;
        // Buffer too small: report the required size (including NUL) and fail rather
        // than truncating + returning S_OK (breaks the probe-then-grow pattern).
        if (decoded.length + 1 > maxCch) {
            Mem.writeUint32(pcchOut, decoded.length + 1);
            return E_POINTER;
        }
        this.writeWide(pszOut, decoded);
        // On success *pcchOut receives the character count EXCLUDING the terminator.
        Mem.writeUint32(pcchOut, decoded.length);
        return S_OK;
    }
}
