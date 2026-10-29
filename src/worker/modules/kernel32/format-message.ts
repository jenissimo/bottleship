/**
 * FormatMessage's message-definition language: %1..%99 inserts with an optional
 * !printf-spec! (default !s!), the %0/%n/%r/%t escapes, and the
 * FORMAT_MESSAGE_MAX_WIDTH_MASK line-break rule. Shared by the A and W entry points;
 * they differ only in how a %s insert reads its string.
 */
import { ArrayVaListReader, formatCLazy } from "../crt-format";

export const FORMAT_MESSAGE_MAX_WIDTH_MASK = 0x000000ff;

export interface MessageInsertSource {
    /** Insert slot `index` (0-based): one DWORD_PTR, whether from an array or a va_list. */
    readSlot(index: number): number;
    readCString(addr: number, maxLen: number): string;
    readWString?: (addr: number, maxChars: number) => string;
    wide: boolean;
}

/** A slot window that reads lazily, so an insert's spec can consume as many slots as it needs. */
class SlotReader extends ArrayVaListReader {
    constructor(private readonly source: MessageInsertSource, private next: number) {
        super([], 0);
    }
    override nextUint32(): number {
        return this.source.readSlot(this.next++) >>> 0;
    }
}

/**
 * Expand `template` as FormatMessage does. `source` is null when the caller passed no
 * Arguments; an insert then fails the call (null), as it does on Windows.
 */
export function expandMessage(
    template: string,
    flags: { ignoreInserts: boolean; maxWidth: number },
    source: MessageInsertSource | null,
): string | null {
    let out = "";
    const ignoreLineBreaks = flags.maxWidth === FORMAT_MESSAGE_MAX_WIDTH_MASK;
    let i = 0;
    while (i < template.length) {
        const ch = template[i]!;
        if (ch !== "%") {
            if (ignoreLineBreaks && (ch === "\r" || ch === "\n")) {
                if (ch === "\r" && template[i + 1] === "\n") i++;
                out += " ";
            } else {
                out += ch;
            }
            i++;
            continue;
        }
        const esc = template[i + 1];
        if (esc === undefined) {
            out += "%";
            break;
        }
        if (esc >= "1" && esc <= "9") {
            let j = i + 2;
            if (template[j] !== undefined && template[j]! >= "0" && template[j]! <= "9") j++;
            let spec = "s";
            let end = j;
            if (template[j] === "!") {
                const close = template.indexOf("!", j + 1);
                if (close > j + 1) {
                    spec = template.slice(j + 1, close);
                    end = close + 1;
                }
            }
            if (flags.ignoreInserts) {
                out += template.slice(i, end);
                i = end;
                continue;
            }
            if (!source) return null;
            const n = Number(template.slice(i + 1, j));
            // A `*` in the spec consumes insert n itself and the value moves on, as on Windows.
            out += formatCLazy(`%${spec}`, new SlotReader(source, n - 1), source.readCString, {
                wide: source.wide,
                readWString: source.readWString,
            });
            i = end;
            continue;
        }
        switch (esc) {
            case "0":
                return out;
            case "n":
                out += "\r\n";
                break;
            case "r":
                out += "\r";
                break;
            case "t":
                out += "\t";
                break;
            default:
                if (flags.ignoreInserts) out += "%";
                out += esc;
                break;
        }
        i += 2;
    }
    return out;
}
