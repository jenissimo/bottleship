import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

/** MSVC thiscall: callee RET N — use stdcall + stackCleanupBytes in stub generator. */
const makeThiscall = (
    name: string,
    stackCleanupBytes: number,
    overrides: Partial<FunctionDescriptor> = {},
): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(stackCleanupBytes > 0 ? stackCleanupBytes / 4 : 0),
    returnType: overrides.returnType ?? "u32",
    callingConvention: "stdcall",
    stackCleanupBytes,
    ...overrides,
});

const makeCdecl = (
    name: string,
    stackCleanupBytes: number,
    overrides: Partial<FunctionDescriptor> = {},
): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(stackCleanupBytes > 0 ? stackCleanupBytes / 4 : 0),
    returnType: overrides.returnType ?? "u32",
    callingConvention: "cdecl",
    stackCleanupBytes,
    ...overrides,
});

const BS = "?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std";
/** Same type with MSVC back-ref `0` instead of `std` in the return slot. */
const BS0 = "?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0";

export const msvcp60Module: ModuleDescriptor = {
    name: "msvcp60",
    description: "MSVC 6.0 C++ standard library (string and C-locale subset)",
    functions: [
        // Eight-byte POD return values occupy EDX:EAX, not a hidden pointer.
        makeCdecl("_Getcoll", 0),
        makeCdecl("_Getcvt", 0),
        // _Ctypevec is 16 bytes and uses a hidden caller-cleaned result pointer.
        makeCdecl("_Getctype", 4),
        makeCdecl("_Mbrtowc", 20),
        makeCdecl("_Wcrtomb", 16),
        makeCdecl("_Strcoll", 20),
        makeCdecl("_Strxfrm", 20),
        makeCdecl("_Tolower", 8),
        makeCdecl("_Toupper", 8),
        makeCdecl("btowc", 4),
        makeCdecl("wctob", 4),

        makeThiscall(`?_Tidy@${BS}@@AAEX_N@Z`, 4),
        makeCdecl("?_Xlen@std@@YAXXZ", 0, { returnType: "void" }),
        makeThiscall(`?_Copy@${BS}@@AAEXI@Z`, 4),
        makeThiscall(`?erase@${BS}@@QAEAAV12@II@Z`, 8),
        makeCdecl("?_Xran@std@@YAXXZ", 0, { returnType: "void" }),
        makeThiscall(`?_Split@${BS}@@AAEXXZ`, 0),
        makeThiscall(`?_Grow@${BS}@@AAE_NI_N@Z`, 8),
        makeThiscall(`?_Eos@${BS}@@AAEXI@Z`, 4),
        makeThiscall(`?_Refcnt@${BS}@@AAEAAEPBD@Z`, 4),
        makeThiscall(`?assign@${BS}@@QAEAAV12@ABV12@II@Z`, 12),
        makeThiscall(`?assign@${BS}@@QAEAAV12@PBDI@Z`, 8),
        makeCdecl("??8std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@PBD@Z", 8),
        makeCdecl("??6std@@YAAAV?$basic_ostream@DU?$char_traits@D@std@@@0@AAV10@PBD@Z", 8),
        makeThiscall("??0Init@ios_base@std@@QAE@XZ", 0),
        makeThiscall("??1Init@ios_base@std@@QAE@XZ", 0),
        makeThiscall("??0_Winit@std@@QAE@XZ", 0),
        makeThiscall("??1_Winit@std@@QAE@XZ", 0),
        makeCdecl(`?npos@${BS}@@2IB`, 0),
        makeCdecl(`?_C@?1??_Nullstr@${BS}@@CAPBDXZ@4DB`, 0),

        // std::basic_string<char> — public API used by game imports
        makeThiscall(`??0${BS}@@QAE@XZ`, 0),
        makeThiscall(`??0${BS}@@QAE@PBDABV?$allocator@D@1@@Z`, 8),
        makeThiscall(`??0${BS}@@QAE@ABV01@@Z`, 4),
        makeThiscall(`??1${BS}@@QAE@XZ`, 0, { returnType: "void" }),
        makeThiscall(`??_F${BS}@@QAEXXZ`, 0),
        makeThiscall(`?_Freeze@${BS}@@AAEXXZ`, 0),
        makeThiscall(`?c_str@${BS}@@QBEPBDXZ`, 0),
        makeThiscall(`?max_size@${BS}@@QBEIXZ`, 0),
        makeThiscall(`?find@${BS}@@QBEIPBDII@Z`, 12),
        makeThiscall(`?find_first_of@${BS}@@QBEIPBDII@Z`, 12),
        makeThiscall(`?find_last_of@${BS}@@QBEIPBDII@Z`, 12),
        makeThiscall(`?insert@${BS}@@QAEAAV12@IPBDI@Z`, 12),
        makeThiscall(`?append@${BS}@@QAEAAV12@PBDI@Z`, 8),
        makeThiscall(`?append@${BS}@@QAEAAV12@ID@Z`, 8),
        makeCdecl(`??8std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z`, 8),
        makeCdecl("??9std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z", 8),
        makeCdecl("??9std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@PBD@Z", 8),
        makeCdecl("??Mstd@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z", 8),
        makeCdecl(`??Hstd@@YA?AV${BS}@@ABV10@0@Z`, 12),
        makeCdecl(`??Hstd@@YA?AV${BS0}@ABV10@0@Z`, 12),
        makeCdecl(`??Hstd@@YA?AV${BS0}@PBDABV10@@Z`, 12),
        makeCdecl(`??Hstd@@YA?AV${BS0}@ABV10@PBD@Z`, 12),

        // Exception / CRT lock helpers
        makeCdecl("??_7bad_cast@std@@6B@", 0),
        makeThiscall("??0bad_cast@std@@QAE@PBD@Z", 4),
        makeThiscall("??0bad_cast@std@@QAE@ABV01@@Z", 4),
        makeThiscall("??1bad_cast@std@@UAE@XZ", 0, { returnType: "void" }),
        makeThiscall("??4bad_cast@std@@QAEAAV01@ABV01@@Z", 4),
        makeCdecl("??_7out_of_range@std@@6B@", 0),
        makeThiscall("??0out_of_range@std@@QAE@ABV01@@Z", 4),
        makeThiscall("??1out_of_range@std@@UAE@XZ", 0),
        makeCdecl("??_7runtime_error@std@@6B@", 0),
        makeThiscall("??0runtime_error@std@@QAE@ABV01@@Z", 4),
        makeThiscall("??1runtime_error@std@@UAE@XZ", 0),
        makeCdecl("??_7logic_error@std@@6B@", 0),
        makeThiscall("??0logic_error@std@@QAE@ABV01@@Z", 4),
        // logic_error(const std::string&) — primary ctor (game throws with a std::string message directly)
        makeThiscall("??0logic_error@std@@QAE@ABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@1@@Z", 4),
        makeThiscall("??0_Lockit@std@@QAE@XZ", 0),
        makeThiscall("??1_Lockit@std@@QAE@XZ", 0),
        makeThiscall("??4_Lockit@std@@QAEAAV01@ABV01@@Z", 4),
    ],
};
