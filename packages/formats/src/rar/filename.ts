/** RAR 3.x/4.x Unicode names: ANSI prefix, NUL, then two-bit UTF-16 commands. */
export function decodeRar4Name(bytes: Uint8Array, unicode: boolean): string {
    if (!unicode) return new TextDecoder('windows-1252').decode(bytes).replace(/\0.*$/s, '');
    const separator = bytes.indexOf(0);
    if (separator < 0) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const ansi = bytes.subarray(0, separator);
    const encoded = bytes.subarray(separator + 1);
    let pos = 0, flags = 0, flagBits = 0;
    const read = () => {
        if (pos >= encoded.length) throw new Error('RAR4: truncated Unicode filename');
        return encoded[pos++];
    };
    const high = read() << 8;
    const chars: string[] = [];
    const emit = (code: number) => {
        if (chars.length >= 0xffff) throw new Error('RAR4: Unicode filename too long');
        chars.push(String.fromCharCode(code));
    };
    while (pos < encoded.length) {
        if (flagBits === 0) { flags = read(); flagBits = 8; }
        const command = flags >>> 6;
        flags = (flags << 2) & 255; flagBits -= 2;
        switch (command) {
            case 0: emit(read()); break;
            case 1: emit(high | read()); break;
            case 2: {
                const low = read();
                emit(low | (read() << 8));
                break;
            }
            case 3: {
                const run = read();
                const corrected = !!(run & 128);
                const correction = corrected ? read() : 0;
                const count = (run & 127) + 2;
                if (chars.length + count > ansi.length) throw new Error('RAR4: Unicode filename copy exceeds ANSI prefix');
                for (let i = 0; i < count; i++) {
                    const byte = ansi[chars.length];
                    emit(corrected ? high | ((byte + correction) & 255) : byte);
                }
                break;
            }
        }
    }
    if (!chars.length) throw new Error('RAR4: empty Unicode filename');
    return chars.join('');
}
