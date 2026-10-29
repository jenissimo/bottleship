import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import { registerMsvcrtTimeLocaleExports } from "../../src/worker/modules/msvcrt-time-locale";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";
// ABI and ownership per the pre-UCRT <time.h> helpers; formatting per Microsoft's strftime
// contract, with Wine's pre-UCRT C-locale behavior as the observed reference.
let mem: Uint8Array, exports: Record<string, ThunkImplementation>, next: number, errno: number;
let locale: string, failAllocation: boolean;
let allocations: Array<[number, number]>;
const call = (name: string, ...args: number[]) => exports[name]!(null as never, mem, args) as number;
const put = (p: number, s: string) => Mem.writeBytes(p, Uint8Array.from([...s].map(c => c.charCodeAt(0)).concat(0)));
const get = (p: number) => { let s=""; for (; mem[p]; p++) s+=String.fromCharCode(mem[p]!); return s; };
const tm = (values=[9,5,13,29,1,124,4,59,0]) => values.forEach((x,i) => Mem.writeUint32(0x200+4*i,x));
const format = (fmt: string, cap=256, snapshot=0) => {
    put(0x300,fmt); const length=call("_Strftime",0x600,cap,0x300,0x200,snapshot);
    return {length,text:get(0x600)};
};
describe("VC6 time locale boundary", () => {
    beforeEach(() => {
        mem=new Uint8Array(0x20000); Mem.bind(() => mem); exports={}; next=0x2000; errno=0;
        locale="C"; failAllocation=false; allocations=[];
        registerMsvcrtTimeLocaleExports(exports, {
            alloc: size => { if (failAllocation) return 0; const p=next; next+=(size+7)&~7; allocations.push([p,size]); return p; },
            hasCLocale: () => locale === "C",
            setErrno: value => { errno=value; },
        }); tm();
    });
    test("registers the helpers as cdecl with their arities", () => {
        const r=APIRegistry.getInstance(); r.registerModule(msvcrtModule);
        for (const [name,n] of [["_Getdays",0],["_Getmonths",0],["_Gettnames",0],["_Strftime",5],["strftime",4]] as const) {
            expect(r.getArgCount("msvcrt",name)).toBe(n); expect(r.getCallingConvention("msvcrt",name)).toBe("cdecl");
        }
    });
    test("lists are independently owned, colon-delimited allocations", () => {
        const a=call("_Getdays"), b=call("_Getdays"), c=call("_Getmonths");
        expect(get(a)).toBe(":Sun:Sunday:Mon:Monday:Tue:Tuesday:Wed:Wednesday:Thu:Thursday:Fri:Friday:Sat:Saturday");
        expect(get(c)).toBe(":Jan:January:Feb:February:Mar:March:Apr:April:May:May:Jun:June:Jul:July:Aug:August:Sep:September:Oct:October:Nov:November:Dec:December");
        expect(b).not.toBe(a); Mem.writeUint8(a,33); expect(get(b).startsWith(":Sun")).toBe(true);
        expect(allocations[0]![1]).toBe(get(b).length+1);
    });
    test("allocation failure returns NULL without writing at zero", () => {
        mem[0]=0xcc; failAllocation=true;
        for (const n of ["_Getdays","_Getmonths","_Gettnames"]) expect(call(n)).toBe(0);
        expect(errno).toBe(12); expect(mem[0]).toBe(0xcc);
    });
    test("time snapshot contains independent names used as fifth argument", () => {
        const a=call("_Gettnames"), b=call("_Gettnames"); expect(a).not.toBe(b);
        put(Mem.readUint32(a+14*4)!,"Jax"); tm([9,5,13,2,0,124,2,1,0]);
        expect(format("%b",256,a).text).toBe("Jax");
        expect(format("%b",256,b).text).toBe("Jan"); expect(format("%b").text).toBe("Jan");
    });
    test("original C locale formatting preserves supplied tm fields", () => {
        expect(format("%a %A %b %B %d %H %I %j %m %M %p %S %w %y %Y %%").text)
            .toBe("Thu Thursday Feb February 29 13 01 060 02 05 PM 09 4 24 2024 %");
        expect(format("%c | %x | %X").text).toBe("02/29/24 13:05:09 | 02/29/24 | 13:05:09");
        expect(format("%#x | %#c").text).toBe("Thursday, February 29, 2024 | Thursday, February 29, 2024 13:05:09");
        expect(format("%#d %#H %#I %#j %#m %#M %#S %#y %#Y").text).toBe("29 13 1 60 2 5 9 24 2024");
    });
    test("Sunday/Monday week boundaries use supplied yday", () => {
        tm([0,0,0,1,0,123,0,0,0]); expect(format("%U %W").text).toBe("01 00");
        tm([0,0,0,2,0,123,1,1,0]); expect(format("%U %W").text).toBe("01 01");
        tm([0,0,0,31,11,123,0,364,0]); expect(format("%U %W").text).toBe("53 52");
    });
    test("midnight/noon and empty output", () => {
        tm([59,0,0,1,0,124,1,0,0]); expect(format("%I %p %S").text).toBe("12 AM 59");
        tm([0,0,12,1,0,124,1,0,0]); expect(format("%I %p").text).toBe("12 PM");
        expect(format("")).toEqual({length:0,text:""});
    });
    test("pre-UCRT seconds stop at 59 for numeric and composite formats", () => {
        tm([60,0,0,1,0,124,1,0,0]);
        for (const specifier of ["%S", "%#S", "%X", "%c", "%#c"]) {
            expect(format(specifier)).toEqual({length:0,text:""});
            expect(errno).toBe(22);
        }
        // strftime only validates fields used by the requested conversion.
        expect(format("%Y").text).toBe("2024");
    });
    test("exact fit counts no NUL; short/zero buffer preserves canary", () => {
        mem.fill(0xcc,0x600,0x620); expect(format("%Y",5)).toEqual({length:4,text:"2024"}); expect(mem[0x605]).toBe(0xcc);
        mem.fill(0xcc,0x600,0x620); expect(format("%Y",4)).toEqual({length:0,text:""}); expect(mem[0x604]).toBe(0xcc); expect(errno).toBe(34);
        mem[0x600]=0xcc; put(0x300,"%Y"); expect(call("_Strftime",0x600,0,0x300,0x200,0)).toBe(0); expect(mem[0x600]).toBe(0xcc);
    });
    test("a caller that doubles its buffer until %#c fits terminates", () => {
        const p=call("_Gettnames"); let cap=8, r;
        do { r=format("!%#c",cap,p); cap*=2; } while (!r.length && cap<=128);
        expect(r!.text).toBe("!Thursday, February 29, 2024 13:05:09"); expect(cap).toBe(128);
    });
    test("invalid input fails; unsupported locale/timezone remains explicit", () => {
        tm([9,5,13,29,12,124,4,59,0]); expect(format("%B").length).toBe(0); expect(errno).toBe(22);
        expect(format("%Q").length).toBe(0); expect(format("%").length).toBe(0);
        locale="French"; expect(() => call("_Getdays")).toThrow("unsupported LC_TIME");
        expect(format("%Y").length).toBe(0); expect(errno).toBe(22);
        locale="C"; expect(() => format("%Z")).toThrow("timezone");
    });
    test("failed guest writes and invalid reads never return a successful result", () => {
        Mem.bind(() => mem, (p,n) => p>=0 && p+n<=mem.length);
        put(0x300,"%Y");
        expect(() => call("_Strftime",mem.length-2,8,0x300,0x200,0)).toThrow("time string write");
        expect(() => call("_Strftime",mem.length+1,1,0x300,0x200,0)).toThrow("time terminator write");
        next=mem.length-1; expect(() => call("_Getdays")).toThrow("time string write");
        next=mem.length-1; expect(() => call("_Gettnames")).toThrow("time-data write");
        Mem.bind(() => mem);
        expect(() => call("_Strftime",0x600,8,mem.length+1,0x200,0)).toThrow("unreadable time string");
    });
    test("literal bytes survive; strftime shares behavior using four arguments", () => {
        put(0x300,"\xe9 %Y"); expect(call("strftime",0x600,20,0x300,0x200)).toBe(6);
        expect(mem[0x600]).toBe(0xe9); expect(get(0x600)).toBe("\xe9 2024");
    });
});
