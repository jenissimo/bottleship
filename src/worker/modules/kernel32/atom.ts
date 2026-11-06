/**
 * Kernel32 Atom Table functions
 *
 * Global atom table for storing strings
 * Atomic implementation for atom operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { encodeAnsi } from '../codepage-utils';

// Global atom table
// @participant(kernel32)
const atomTable: Map<number, string> = new Map();
// @participant(kernel32)
let nextAtomId = 0xC000; // Start from user-defined atom range

// @participant(kernel32)
const localAtoms: Map<number, string> = new Map();
// @participant(kernel32)
let nextLocalAtomId = 0xC000;

export function resetAtomTable(): void {
    atomTable.clear();
    nextAtomId = 0xC000;
    localAtoms.clear();
    nextLocalAtomId = 0xC000;
}

export interface AtomState {
    atoms: Array<[number, string]>;
    nextAtomId: number;
    localAtoms: Array<[number, string]>;
    nextLocalAtomId: number;
}

export function captureAtoms(): AtomState {
    return { atoms: [...atomTable], nextAtomId, localAtoms: [...localAtoms], nextLocalAtomId };
}

export function restoreAtoms(state: AtomState): void {
    atomTable.clear();
    for (const [id, name] of state.atoms) atomTable.set(id, name);
    nextAtomId = state.nextAtomId;
    localAtoms.clear();
    for (const [id, name] of state.localAtoms) localAtoms.set(id, name);
    nextLocalAtomId = state.nextLocalAtomId;
}

const MAXINTATOM = 0xC000;

function localAtomKey(text: string): string | number {
    if (/^#\d+$/.test(text)) return Number(text.slice(1)) & 0xffff;
    return text;
}

function localAtomArg(lpString: number, read: (address: number) => string): string | number | null {
    if (!lpString) return null;
    if (lpString < 0x10000) return lpString & 0xffff;
    const text = read(lpString);
    return text ? localAtomKey(text) : null;
}

function findLocalAtom(name: string): number {
    const key = name.toLowerCase();
    for (const [atom, value] of localAtoms) if (value.toLowerCase() === key) return atom;
    return 0;
}

function addLocalAtom(name: string | number | null): number {
    if (name === null) return 0;
    if (typeof name === 'number') return name > 0 && name < MAXINTATOM ? name : 0;
    const known = findLocalAtom(name);
    if (known) return known;
    if (nextLocalAtomId > 0xffff) return 0;
    const atom = nextLocalAtomId++;
    localAtoms.set(atom, name);
    return atom;
}

function localAtomName(atom: number): string | null {
    const a = atom & 0xffff;
    if (a > 0 && a < MAXINTATOM) return `#${a}`;
    return localAtoms.get(a) ?? null;
}

export const exports: Record<string, ThunkImplementation> = {
    /**
     * GlobalAddAtomA - Adds a character string to the global atom table
     * @param lpString - Pointer to null-terminated string
     * @returns Atom value (0xC000-0xFFFF) or 0 on error
     */
    'GlobalAddAtomA': (ctx, mem, args) => {
        const lpString = args[0];

        if (!lpString) {
            Logger.warn(LogCategory.KERNEL32, 'GlobalAddAtomA: NULL string pointer');
            return 0;
        }

        const str = Marshaler.readString(mem, lpString);
        if (!str) {
            Logger.warn(LogCategory.KERNEL32, 'GlobalAddAtomA: Empty string');
            return 0;
        }

        // Check if atom already exists
        for (const [atom, value] of atomTable.entries()) {
            if (value === str) {
                Logger.log(LogCategory.KERNEL32, `GlobalAddAtomA: Found existing atom 0x${atom.toString(16)} for "${str}"`);
                return atom;
            }
        }

        // Create new atom
        const atom = nextAtomId++;
        atomTable.set(atom, str);

        Logger.log(LogCategory.KERNEL32, `GlobalAddAtomA: Created atom 0x${atom.toString(16)} for "${str}"`);
        return atom;
    },

    /**
     * GlobalAddAtomW - Wide string version of GlobalAddAtomA
     */
    'GlobalAddAtomW': (ctx, mem, args) => {
        const lpString = args[0];
        if (!lpString) return 0;

        const str = Marshaler.readWideString(mem, lpString);
        if (!str) return 0;

        // Check if atom already exists
        for (const [atom, value] of atomTable.entries()) {
            if (value === str) return atom;
        }

        const atom = nextAtomId++;
        atomTable.set(atom, str);
        Logger.log(LogCategory.KERNEL32, `GlobalAddAtomW: Created atom 0x${atom.toString(16)} for "${str}"`);
        return atom;
    },

    /**
     * GlobalFindAtomA - Looks up a string in the global atom table
     */
    'GlobalFindAtomA': (ctx, mem, args) => {
        const lpString = args[0];
        if (!lpString) return 0;

        const str = Marshaler.readString(mem, lpString);
        if (!str) return 0;

        for (const [atom, value] of atomTable.entries()) {
            if (value === str) {
                Logger.verbose(LogCategory.KERNEL32, `GlobalFindAtomA: Found atom 0x${atom.toString(16)} for "${str}"`);
                return atom;
            }
        }
        return 0;
    },

    /**
     * GlobalFindAtomW - Wide string version of GlobalFindAtomA
     */
    'GlobalFindAtomW': (ctx, mem, args) => {
        const lpString = args[0];
        if (!lpString) return 0;

        const str = Marshaler.readWideString(mem, lpString);
        if (!str) return 0;

        for (const [atom, value] of atomTable.entries()) {
            if (value === str) return atom;
        }
        return 0;
    },

    /**
     * GlobalGetAtomNameA - Retrieves a copy of the string associated with an atom
     * @param nAtom - Atom identifier
     * @param lpBuffer - Pointer to buffer for string
     * @param nSize - Size of buffer in characters
     * @returns Number of characters copied (excluding null terminator) or 0 on error
     */
    'GlobalGetAtomNameA': (ctx, mem, args) => {
        const nAtom = args[0];
        const lpBuffer = args[1];
        const nSize = args[2];

        if (!lpBuffer || nSize <= 0) {
            Logger.warn(LogCategory.KERNEL32, `GlobalGetAtomNameA: Invalid buffer (ptr=0x${lpBuffer.toString(16)}, size=${nSize})`);
            return 0;
        }

        const str = atomTable.get(nAtom);
        if (!str) {
            Logger.warn(LogCategory.KERNEL32, `GlobalGetAtomNameA: Atom 0x${nAtom.toString(16)} not found`);
            return 0;
        }

        const strBytes = encodeAnsi(str);
        const maxLen = Math.min(strBytes.length, nSize - 1);
        mem.set(strBytes.subarray(0, maxLen), lpBuffer);
        mem[lpBuffer + maxLen] = 0; // Null terminator

        Logger.log(LogCategory.KERNEL32, `GlobalGetAtomNameA: Retrieved "${str}" for atom 0x${nAtom.toString(16)}`);
        return maxLen;
    },

    /**
     * GlobalDeleteAtom - Decrements the reference count of an atom
     * @param nAtom - Atom to delete
     * @returns 0 on success, nAtom on failure
     */
    'GlobalDeleteAtom': (ctx, mem, args) => {
        const nAtom = args[0];

        if (!atomTable.has(nAtom)) {
            Logger.warn(LogCategory.KERNEL32, `GlobalDeleteAtom: Atom 0x${nAtom.toString(16)} not found`);
            return nAtom;
        }

        const str = atomTable.get(nAtom);
        atomTable.delete(nAtom);

        Logger.log(LogCategory.KERNEL32, `GlobalDeleteAtom: Deleted atom 0x${nAtom.toString(16)} ("${str}")`);
        return 0;
    },
};

const readAnsi = (mem: Uint8Array) => (address: number) => Marshaler.readString(mem, address);
const readWide = (mem: Uint8Array) => (address: number) => Marshaler.readWideString(mem, address);

exports['AddAtomA'] = (ctx, mem, args) => addLocalAtom(localAtomArg(args[0] >>> 0, readAnsi(mem)));
exports['AddAtomW'] = (ctx, mem, args) => addLocalAtom(localAtomArg(args[0] >>> 0, readWide(mem)));

function findLocal(name: string | number | null): number {
    if (name === null) return 0;
    if (typeof name === 'number') return name > 0 && name < MAXINTATOM ? name : 0;
    return findLocalAtom(name);
}

exports['FindAtomA'] = (ctx, mem, args) => findLocal(localAtomArg(args[0] >>> 0, readAnsi(mem)));
exports['FindAtomW'] = (ctx, mem, args) => findLocal(localAtomArg(args[0] >>> 0, readWide(mem)));

exports['GetAtomNameA'] = (ctx, mem, args) => {
    const lpBuffer = args[1] >>> 0;
    const nSize = args[2] | 0;
    const name = localAtomName(args[0] >>> 0);
    if (!lpBuffer || nSize <= 0 || name === null) return 0;
    const bytes = encodeAnsi(name);
    const length = Math.min(bytes.length, nSize - 1);
    mem.set(bytes.subarray(0, length), lpBuffer);
    mem[lpBuffer + length] = 0;
    return length;
};

exports['GetAtomNameW'] = (ctx, mem, args) => {
    const lpBuffer = args[1] >>> 0;
    const nSize = args[2] | 0;
    const name = localAtomName(args[0] >>> 0);
    if (!lpBuffer || nSize <= 0 || name === null) return 0;
    const text = name.slice(0, nSize - 1);
    Marshaler.writeWideString(mem, lpBuffer, text);
    return text.length;
};

exports['DeleteAtom'] = (ctx, mem, args) => {
    const atom = (args[0] >>> 0) & 0xffff;
    if (atom > 0 && atom < MAXINTATOM) return 0;
    return localAtoms.delete(atom) ? 0 : atom;
};
