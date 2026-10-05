// msvc-mangling.ts
// Derives callee stack cleanup (RET N bytes) from MSVC C++-mangled export names,
// so a stdcall/thiscall stub without argCount metadata doesn't kill the whole DLL load.
//
// Correct-or-nothing contract: anything outside the confidently understood subset
// (classes/arrays by value, templates, __fastcall, variadics, unresolvable
// back-references, by-value class returns → hidden sret arg the callee also pops)
// returns undefined and the caller keeps its existing throw. A wrong RET N silently
// corrupts the guest stack.

const BAIL: unique symbol = Symbol("msvc-mangling-bail");

class Cursor {
    pos: number;
    constructor(readonly s: string, start: number) {
        this.pos = start;
    }
    next(): string {
        const c = this.s[this.pos++];
        if (c === undefined) throw BAIL;
        return c;
    }
    peek(): string {
        return this.s[this.pos] ?? "";
    }
}

/** One-letter primitives (stack slot size when passed by value). */
const PRIMITIVE_SIZES: Record<string, number> = {
    C: 4, D: 4, E: 4, F: 4, G: 4, H: 4, I: 4, J: 4, K: 4, // signed char .. unsigned long
    M: 4, // float
    N: 8, // double
    O: 8, // long double (== double on Win32)
};

/** '_'-prefixed extended primitives. Sub-4-byte types promote to a 4-byte stack slot. */
const EXTENDED_SIZES: Record<string, number> = {
    D: 4, E: 4, F: 4, G: 4, H: 4, I: 4, // __int8 .. unsigned __int32
    J: 8, K: 8, // __int64 / unsigned __int64
    N: 4, // bool
    W: 4, // wchar_t
};

/** Non-static member functions — a `this` cv-qualifier letter follows. */
const MEMBER_FN_KINDS = "ABEFIJMNQRUV";
const STATIC_FN_KINDS = "CDKLST";
const POINTER_CODES = "PQRS"; // pointer + cv variants
const REFERENCE_CODES = "AB"; // reference, volatile reference

/**
 * Qualified type/class name: '@'-terminated fragments, single digits are name
 * back-references, an immediate '@' ends the list. We only need to skip it.
 */
function skipQualifiedName(cur: Cursor): void {
    for (;;) {
        const c = cur.peek();
        if (c === "") throw BAIL;
        if (c === "@") {
            cur.pos++;
            return;
        }
        if (c >= "0" && c <= "9") {
            cur.pos++;
            continue;
        }
        if (c === "?") throw BAIL; // template / anonymous-namespace fragment
        const at = cur.s.indexOf("@", cur.pos);
        if (at < 0) throw BAIL;
        cur.pos = at + 1;
    }
}

/** Parse one by-value parameter type; returns its stack slot size. Throws BAIL on anything unclear. */
function parseType(cur: Cursor): number {
    const c = cur.next();
    const prim = PRIMITIVE_SIZES[c];
    if (prim !== undefined) return prim;
    if (c === "_") {
        const ext = EXTENDED_SIZES[cur.next()];
        if (ext === undefined) throw BAIL;
        return ext;
    }
    if (c === "W") {
        // Enum: only 'W4' (int-sized) is in scope.
        if (cur.next() !== "4") throw BAIL;
        skipQualifiedName(cur);
        return 4;
    }
    if (POINTER_CODES.includes(c) || REFERENCE_CODES.includes(c)) {
        const q = cur.next();
        if (q === "6") {
            skipFunctionType(cur);
            return 4;
        }
        if (!"ABCD".includes(q)) throw BAIL; // based / member / __ptr64 pointers
        skipPointeeType(cur);
        return 4;
    }
    throw BAIL; // V/U/T by value, arrays ('Y'), '?'-modified, '$' templates, ...
}

function skipPointeeType(cur: Cursor): void {
    const c = cur.peek();
    if (c === "X") {
        cur.pos++; // void*
        return;
    }
    if (c === "V" || c === "U" || c === "T") {
        cur.pos++;
        skipQualifiedName(cur);
        return;
    }
    parseType(cur); // primitives, nested pointers, enums; size irrelevant here
}

function skipReturnType(cur: Cursor): void {
    // By-value class/struct/enum returns mangle as '?A…' → parseType bails, which is
    // required: they imply a hidden sret argument the callee also pops.
    if (cur.peek() === "X") {
        cur.pos++;
        return;
    }
    parseType(cur);
}

/** Function type after 'P6' etc.: <convention> <return> <args> 'Z'. Skipped, size is 4. */
function skipFunctionType(cur: Cursor): void {
    if (!"ABEFGHIJ".includes(cur.next())) throw BAIL;
    skipReturnType(cur);
    if (cur.peek() === "X") {
        cur.pos++;
    } else {
        for (;;) {
            const c = cur.peek();
            if (c === "@" || c === "Z") {
                cur.pos++; // '@' normal end; 'Z' ellipsis end
                break;
            }
            // Nested lists share the outer back-reference table — out of scope.
            if (c >= "0" && c <= "9") throw BAIL;
            parseType(cur);
        }
    }
    if (cur.next() !== "Z") throw BAIL;
}

function parseMangled(s: string): number | undefined {
    if (s[0] !== "?") return undefined;
    const sep = s.indexOf("@@");
    if (sep < 0) return undefined;
    if (s.lastIndexOf("?$", sep) >= 0) return undefined; // templated qualified name

    const cur = new Cursor(s, sep + 2);
    const kind = cur.next();
    const isMemberFn = MEMBER_FN_KINDS.includes(kind);
    const isFreeFn = kind === "Y" || kind === "Z";
    if (!isMemberFn && !isFreeFn && !STATIC_FN_KINDS.includes(kind)) {
        return undefined; // data export, vftable, thunk, ...
    }
    if (isMemberFn && !"ABCD".includes(cur.next())) return undefined; // based/__ptr64 `this`

    const conv = cur.next();
    if (conv === "A" || conv === "B") return 0; // __cdecl — caller cleans regardless of params
    const isThiscall = conv === "E" || conv === "F";
    if (!isThiscall && conv !== "G" && conv !== "H") return undefined; // __fastcall/__pascal/...
    if (isThiscall && !isMemberFn) return undefined;

    // __stdcall / __thiscall: sum parameter stack slots (`this` rides in ECX).
    if (cur.peek() === "@") cur.pos++; // ctor/dtor: no return type
    else skipReturnType(cur);

    let total = 0;
    const backrefs: { enc: string; size: number }[] = [];
    if (cur.peek() === "X") {
        cur.pos++; // void — no parameters
    } else {
        for (;;) {
            const c = cur.peek();
            if (c === "@") {
                cur.pos++;
                break;
            }
            if (c === "Z") return undefined; // variadic is never callee-clean
            if (c >= "0" && c <= "9") {
                cur.pos++;
                const ref = backrefs[Number(c)];
                if (ref === undefined) return undefined;
                total += ref.size;
                continue;
            }
            const start = cur.pos;
            const size = parseType(cur);
            total += size;
            const enc = cur.s.slice(start, cur.pos);
            // Multi-char parameter encodings enter the 10-slot back-reference table (deduped).
            if (enc.length > 1 && backrefs.length < 10 && !backrefs.some((b) => b.enc === enc)) {
                backrefs.push({ enc, size });
            }
        }
    }
    if (cur.next() !== "Z") return undefined;
    if (cur.pos !== s.length) return undefined;
    return total;
}

/**
 * Derive stdcall/thiscall RET-N byte count (or 0 for __cdecl) from an MSVC-mangled
 * export name. Returns undefined for anything outside the safe subset.
 */
export function deriveStackCleanupFromMangledName(mangled: string): number | undefined {
    try {
        return parseMangled(mangled);
    } catch (err) {
        if (err === BAIL) return undefined;
        throw err;
    }
}
