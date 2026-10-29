/** VC6 std::bad_cast shares exception's 12-byte [vptr, name, owns_name] layout. */
import type { CppStringHeap } from "./crt-cppstring-vc6";
import { vc6ReadBytes, vc6ReadU32, vc6WriteBytes, vc6WriteU32 } from "./crt-cpp-memory-vc6";

export const VC6_EXCEPTION_SIZE = 12;

function writeObject(object: number, vtable: number, message: number, owns: number): void {
    const bytes = new Uint8Array(VC6_EXCEPTION_SIZE), view = new DataView(bytes.buffer);
    view.setUint32(0, vtable, true);
    view.setUint32(4, message, true);
    view.setUint32(8, owns, true);
    vc6WriteBytes(object, bytes);
}

export function vc6ExceptionCtor(object: number, message: number, vtable: number, heap: CppStringHeap): number {
    let copy = 0;
    if (message) {
        let length = 0;
        while (true) {
            const ch = vc6ReadBytes(message + length, 1)[0]!;
            length++;
            if (ch === 0) break;
        }
        // The allocator can grow memory, so own the source before making that call.
        const bytes = new Uint8Array(vc6ReadBytes(message, length));
        copy = heap.alloc(length);
        if (!copy) throw new Error("msvcp60: exception message allocation failed");
        try { vc6WriteBytes(copy, bytes); }
        catch (error) { heap.free(copy); throw error; }
    }
    try { writeObject(object, vtable, copy, message ? 1 : 0); }
    catch (error) { if (copy) heap.free(copy); throw error; }
    return object;
}

export function vc6ExceptionCopy(object: number, source: number, vtable: number, heap: CppStringHeap): number {
    const fields = vc6ReadBytes(source, VC6_EXCEPTION_SIZE);
    const view = new DataView(fields.buffer, fields.byteOffset, fields.byteLength);
    const message = view.getUint32(4, true);
    if (view.getUint32(8, true)) return vc6ExceptionCtor(object, message, vtable, heap);
    writeObject(object, vtable, message, 0);
    return object;
}

export function vc6ExceptionDtor(object: number, baseVtable: number, heap: CppStringHeap): void {
    const message = vc6ReadU32(object + 4), owns = vc6ReadU32(object + 8);
    vc6WriteU32(object, baseVtable);
    if (owns) heap.free(message);
}

export function vc6ExceptionWhat(object: number, unknownMessage: number): number {
    return vc6ReadU32(object + 4) || unknownMessage;
}

export function vc6ExceptionDelete(object: number, flags: number, baseVtable: number, heap: CppStringHeap): number {
    if (flags & 2) {
        const allocation = object - 4;
        const count = vc6ReadU32(allocation);
        // Reject an inaccessible cookie-sized array before walking an unbounded count.
        vc6ReadBytes(object, count * VC6_EXCEPTION_SIZE);
        for (let i = count - 1; i >= 0; i--) vc6ExceptionDtor(object + i * VC6_EXCEPTION_SIZE, baseVtable, heap);
        heap.free(allocation);
    } else {
        vc6ExceptionDtor(object, baseVtable, heap);
        if (flags & 1) heap.free(object);
    }
    return object;
}
