/**
 * FormatMessage's message-definition language.
 *
 * A template copied through verbatim still reads as plausible text ("Accelerator -
 * %1(%2)" in a device list) and as a plausible path ("PX_Icon_%1!d!_%2!d!.tga" that
 * then fails to open), so every insert form is pinned here.
 */
import { describe, expect, test } from "bun:test";
import { expandMessage, type MessageInsertSource } from "../../src/worker/modules/kernel32/format-message";

/** Slots hold numbers; a string insert's "pointer" is 1000 + its index in `strings`. */
function source(slots: number[], strings: string[] = [], wide = false): MessageInsertSource {
    const read = (addr: number) => strings[addr - 1000] ?? "";
    return { readSlot: (i) => slots[i] ?? 0, readCString: read, readWString: read, wide };
}
const plain = { ignoreInserts: false, maxWidth: 0 };

describe("FormatMessage inserts", () => {
    test("a bare %n is a string insert", () => {
        expect(expandMessage("Accelerator - %1(%2)", plain, source([1000, 1001], ["Direct3D HAL", "Primary"])))
            .toBe("Accelerator - Direct3D HAL(Primary)");
    });

    test("an insert addresses its slot by number, not by position", () => {
        expect(expandMessage("%2 then %1", plain, source([1000, 1001], ["a", "b"]))).toBe("b then a");
    });

    test("a !printf-spec! formats the insert", () => {
        expect(expandMessage("PX_Icon_%1!d!_%2!d!_%3!03d!.tga", plain, source([4, 0xffffffff, 7])))
            .toBe("PX_Icon_4_-1_007.tga");
        expect(expandMessage("%1!d! rounds of %2", plain, source([12, 1000], ["EX"]))).toBe("12 rounds of EX");
    });

    test("two-digit insert numbers", () => {
        const slots = Array.from({ length: 12 }, (_, i) => i + 1);
        expect(expandMessage("%12!d!/%1!d!", plain, source(slots))).toBe("12/1");
    });

    test("a * width consumes insert n, and the value is the next one", () => {
        expect(expandMessage("[%1!*d!]", plain, source([5, 42]))).toBe("[   42]");
    });

    test("wide calls read %s as UTF-16 and %hs as ANSI", () => {
        const reads: string[] = [];
        const src: MessageInsertSource = {
            readSlot: (i) => 1000 + i,
            readCString: () => { reads.push("A"); return "narrow"; },
            readWString: () => { reads.push("W"); return "wide"; },
            wide: true,
        };
        expect(expandMessage("%1 %2!hs!", plain, src)).toBe("wide narrow");
        expect(reads).toEqual(["W", "A"]);
    });

    test("an insert with no Arguments fails the call", () => {
        expect(expandMessage("value %1", plain, null)).toBeNull();
        expect(expandMessage("no inserts", plain, null)).toBe("no inserts");
    });
});

describe("FormatMessage escapes", () => {
    test("%n is CR LF, %r CR, %t tab, and %0 ends the message", () => {
        expect(expandMessage("a%nb%rc%td%0ignored", plain, null)).toBe("a\r\nb\rc\td");
    });

    test("any other escaped character stands for itself", () => {
        expect(expandMessage("100%% %. %! %b", plain, null)).toBe("100% . ! b");
    });

    test("IGNORE_INSERTS passes inserts and their specs through", () => {
        const flags = { ignoreInserts: true, maxWidth: 0 };
        expect(expandMessage("test%1%2!*.*s!%99%%%n", flags, null)).toBe("test%1%2!*.*s!%99%%\r\n");
    });

    test("MAX_WIDTH_MASK turns source line breaks into spaces but keeps %n", () => {
        expect(expandMessage("one\r\ntwo\nthree%nfour", { ignoreInserts: false, maxWidth: 0xff }, null))
            .toBe("one two three\r\nfour");
        expect(expandMessage("one\r\ntwo", plain, null)).toBe("one\r\ntwo");
    });
});
