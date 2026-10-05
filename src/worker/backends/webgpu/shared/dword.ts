/** Reinterpret a D3D DWORD held in a signed JS/typed-array slot for WebIDL unsigned long fields. */
export function dwordToUnsignedLong(value: number): number {
    return value >>> 0;
}
