/**
 * Kernel32 atom tables: the global table (GlobalAddAtom…) and the process's local
 * table (AddAtom…).
 *
 * Both follow the documented atom rules (learn.microsoft.com, "About Atom Tables"):
 * - String atoms are 0xC000–0xFFFF. Names compare case-insensitively.
 * - Each string atom has a reference count. Adding an existing name increments it,
 *   and DeleteAtom/GlobalDeleteAtom decrements it. The atom goes away only at zero.
 * - Integer atoms (MAKEINTATOM(n), or the string "#n") are 0x0001–0xBFFF. They come
 *   back as given, never enter the table, and deleting one always succeeds.
 *   GetAtomName answers "#n" for them.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { encodeAnsi } from '../codepage-utils';

const MAXINTATOM = 0xC000;
const LAST_ATOM = 0xFFFF;

interface AtomEntry { name: string; refs: number }

/** One saved table: `[atom, name, refs]` rows and the next atom to try. */
export interface SavedAtomTable { entries: Array<[number, string, number]>; next: number }

class AtomTable {
    readonly entries = new Map<number, AtomEntry>();
    private readonly byName = new Map<string, number>();
    next = MAXINTATOM;

    constructor(readonly label: string) {}

    reset(): void {
        this.entries.clear();
        this.byName.clear();
        this.next = MAXINTATOM;
    }

    find(name: string): number {
        return this.byName.get(name.toLowerCase()) ?? 0;
    }

    add(name: string): number {
        const known = this.find(name);
        if (known) {
            const entry = this.entries.get(known)!;
            entry.refs++;
            Logger.log(LogCategory.KERNEL32, `${this.label}: "${name}" is atom 0x${known.toString(16)}, refs ${entry.refs}`);
            return known;
        }
        const atom = this.freeAtom();
        if (!atom) {
            Logger.warn(LogCategory.KERNEL32, `${this.label}: table full, "${name}" not added`);
            return 0;
        }
        this.entries.set(atom, { name, refs: 1 });
        this.byName.set(name.toLowerCase(), atom);
        Logger.log(LogCategory.KERNEL32, `${this.label}: created atom 0x${atom.toString(16)} for "${name}"`);
        return atom;
    }

    /** True when the atom was in the table (its count dropped, perhaps to zero). */
    delete(atom: number): boolean {
        const entry = this.entries.get(atom);
        if (!entry) {
            Logger.warn(LogCategory.KERNEL32, `${this.label}: delete of unknown atom 0x${atom.toString(16)}`);
            return false;
        }
        if (--entry.refs > 0) {
            Logger.log(LogCategory.KERNEL32, `${this.label}: atom 0x${atom.toString(16)} ("${entry.name}") refs ${entry.refs}`);
            return true;
        }
        this.entries.delete(atom);
        this.byName.delete(entry.name.toLowerCase());
        Logger.log(LogCategory.KERNEL32, `${this.label}: deleted atom 0x${atom.toString(16)} ("${entry.name}")`);
        return true;
    }

    name(atom: number): string | null {
        return this.entries.get(atom)?.name ?? null;
    }

    capture(): SavedAtomTable {
        return { entries: [...this.entries].map(([atom, e]) => [atom, e.name, e.refs]), next: this.next };
    }

    restore(saved: SavedAtomTable): void {
        this.entries.clear();
        this.byName.clear();
        for (const [atom, name, refs] of saved.entries) {
            this.entries.set(atom, { name, refs });
            this.byName.set(name.toLowerCase(), atom);
        }
        this.next = saved.next;
    }

    /** The next unused string atom; after the range runs out, the lowest freed one. */
    private freeAtom(): number {
        if (this.next <= LAST_ATOM) return this.next++;
        for (let atom = MAXINTATOM; atom <= LAST_ATOM; atom++) if (!this.entries.has(atom)) return atom;
        return 0;
    }
}

// @participant(kernel32)
const globalAtoms = new AtomTable('GlobalAtom');
// @participant(kernel32)
const localAtoms = new AtomTable('LocalAtom');

export function resetAtomTable(): void {
    globalAtoms.reset();
    localAtoms.reset();
}

export interface AtomState { global: SavedAtomTable; local: SavedAtomTable }

export function captureAtoms(): AtomState {
    return { global: globalAtoms.capture(), local: localAtoms.capture() };
}

export function restoreAtoms(state: AtomState): void {
    globalAtoms.restore(state.global);
    localAtoms.restore(state.local);
}

/** An atom argument: an integer atom, a name, or null for NULL, "" and malformed "#n". */
type AtomKey = number | string | null;

function integerAtom(n: number): number | null {
    return Number.isInteger(n) && n > 0 && n < MAXINTATOM ? n : null;
}

function atomArg(lpString: number, read: (address: number) => string): AtomKey {
    if (!lpString) return null;
    if (lpString < 0x10000) return integerAtom(lpString);
    const text = read(lpString);
    if (!text) return null;
    if (/^#\d+$/.test(text)) return integerAtom(Number(text.slice(1)));
    return text;
}

function addAtom(table: AtomTable, key: AtomKey): number {
    if (key === null) return 0;
    return typeof key === 'number' ? key : table.add(key);
}

function findAtom(table: AtomTable, key: AtomKey): number {
    if (key === null) return 0;
    return typeof key === 'number' ? key : table.find(key);
}

/** 0 on success, the atom itself on failure. */
function deleteAtom(table: AtomTable, atom: number): number {
    const a = atom & 0xffff;
    if (a > 0 && a < MAXINTATOM) return 0;
    return table.delete(a) ? 0 : atom;
}

function atomName(table: AtomTable, atom: number): string | null {
    const a = atom & 0xffff;
    if (a > 0 && a < MAXINTATOM) return `#${a}`;
    return table.name(a);
}

function getAtomNameA(table: AtomTable, mem: Uint8Array, args: number[]): number {
    const lpBuffer = args[1] >>> 0;
    const nSize = args[2] | 0;
    const name = atomName(table, args[0] >>> 0);
    if (!lpBuffer || nSize <= 0 || name === null) {
        Logger.warn(LogCategory.KERNEL32, `${table.label}: GetAtomNameA(0x${(args[0] >>> 0).toString(16)}) failed`);
        return 0;
    }
    const bytes = encodeAnsi(name);
    const length = Math.min(bytes.length, nSize - 1);
    mem.set(bytes.subarray(0, length), lpBuffer);
    mem[lpBuffer + length] = 0;
    return length;
}

function getAtomNameW(table: AtomTable, mem: Uint8Array, args: number[]): number {
    const lpBuffer = args[1] >>> 0;
    const nSize = args[2] | 0;
    const name = atomName(table, args[0] >>> 0);
    if (!lpBuffer || nSize <= 0 || name === null) {
        Logger.warn(LogCategory.KERNEL32, `${table.label}: GetAtomNameW(0x${(args[0] >>> 0).toString(16)}) failed`);
        return 0;
    }
    const text = name.slice(0, nSize - 1);
    Marshaler.writeWideString(mem, lpBuffer, text);
    return text.length;
}

const readAnsi = (mem: Uint8Array) => (address: number) => Marshaler.readString(mem, address);
const readWide = (mem: Uint8Array) => (address: number) => Marshaler.readWideString(mem, address);

export const exports: Record<string, ThunkImplementation> = {
    'GlobalAddAtomA': (ctx, mem, args) => addAtom(globalAtoms, atomArg(args[0] >>> 0, readAnsi(mem))),
    'GlobalAddAtomW': (ctx, mem, args) => addAtom(globalAtoms, atomArg(args[0] >>> 0, readWide(mem))),
    'GlobalFindAtomA': (ctx, mem, args) => findAtom(globalAtoms, atomArg(args[0] >>> 0, readAnsi(mem))),
    'GlobalFindAtomW': (ctx, mem, args) => findAtom(globalAtoms, atomArg(args[0] >>> 0, readWide(mem))),
    'GlobalGetAtomNameA': (ctx, mem, args) => getAtomNameA(globalAtoms, mem, args),
    'GlobalGetAtomNameW': (ctx, mem, args) => getAtomNameW(globalAtoms, mem, args),
    'GlobalDeleteAtom': (ctx, mem, args) => deleteAtom(globalAtoms, args[0] >>> 0),

    'AddAtomA': (ctx, mem, args) => addAtom(localAtoms, atomArg(args[0] >>> 0, readAnsi(mem))),
    'AddAtomW': (ctx, mem, args) => addAtom(localAtoms, atomArg(args[0] >>> 0, readWide(mem))),
    'FindAtomA': (ctx, mem, args) => findAtom(localAtoms, atomArg(args[0] >>> 0, readAnsi(mem))),
    'FindAtomW': (ctx, mem, args) => findAtom(localAtoms, atomArg(args[0] >>> 0, readWide(mem))),
    'GetAtomNameA': (ctx, mem, args) => getAtomNameA(localAtoms, mem, args),
    'GetAtomNameW': (ctx, mem, args) => getAtomNameW(localAtoms, mem, args),
    'DeleteAtom': (ctx, mem, args) => deleteAtom(localAtoms, args[0] >>> 0),
};
