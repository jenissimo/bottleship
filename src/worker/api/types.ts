/**
 * API Descriptor Types for HLE Module Generation
 *
 * These types define the structure for describing Windows API functions
 * and COM interfaces, enabling code generation for:
 * - Stub DLLs
 * - VTables
 * - Thunk registrations
 * - Argument marshaling
 */

export type CallingConvention = "stdcall" | "cdecl" | "thiscall";

export type ParameterType =
    | "u8"
    | "i8"
    | "u16"
    | "i16"
    | "u32"
    | "i32"
    | "u64"
    | "i64"
    | "f32"
    | "f64"
    | "ptr"
    | "handle"
    | "string"   // ANSI null-terminated
    | "wstring"  // UTF-16LE null-terminated
    | "struct"
    | "void";

export type ParameterDirection = "in" | "out" | "inout";

/**
 * What an export answers with when it is DECLARED here but no handler is registered.
 *
 * A declaration is an ABI promise (so the PE loader can emit a stack-correct stub), not
 * a promise that the function works. When the stub runs with nothing behind it, the one
 * thing it must never do is look like success — the caller then walks its success branch
 * over out-params we never wrote.
 *
 * "zero" is the default and the only value that fails under every POINTER/HANDLE/BOOL/
 * count convention at once. It is a *success* under the status-code conventions
 * (HRESULT S_OK, MMSYSERR_NOERROR, MCI 0, ERROR_SUCCESS), which is exactly why an export
 * that returns one of those must name its class here.
 */
export type UnimplementedReturn =
    /** BOOL FALSE / NULL pointer / NULL handle / zero count. Win32's own failure value. */
    | "zero"
    /** INVALID_HANDLE_VALUE (-1) — the CreateFile/FindFirstFile family, where NULL reads as a handle. */
    | "invalidHandle"
    /** The bare -1 sentinel: SOCKET_ERROR / INVALID_SOCKET, INVALID_SET_FILE_POINTER, INVALID_FILE_SIZE. */
    | "minusOne"
    /** E_NOTIMPL. Any HRESULT return, including every COM vtable method. */
    | "hresult"
    /** MMSYSERR_NOTSUPPORTED (8) — winmm/msacm, where 0 is MMSYSERR_NOERROR. */
    | "mmresult"
    /** MCIERR_UNSUPPORTED_FUNCTION (274) — MCI commands, where 0 is success. */
    | "mcierror"
    /** ERROR_CALL_NOT_IMPLEMENTED (120) — LSTATUS/LONG returns carrying a Win32 code (Reg*). */
    | "win32Status"
    /**
     * No value reads as failure — every bit pattern is a legal answer (GetTickCount64).
     * Returning anything at all is a lie, so the export does not resolve: GetProcAddress
     * hands back NULL, exactly as a Windows without the function does, and the caller
     * takes the fallback path it already carries. An IAT import cannot be refused that
     * way, so the stub still answers 0 — and says so.
     */
    | "unresolvable";

export interface ParameterDescriptor {
    name: string;
    type: ParameterType;
    direction?: ParameterDirection;  // Default: "in"
    structName?: string;  // For struct types
    structSize?: number;  // Size in bytes for struct types
    optional?: boolean;   // Can be NULL
}

export interface FunctionDescriptor {
    name: string;
    ordinal?: number;  // For DLL exports by ordinal
    params: ParameterDescriptor[];
    returnType: ParameterType;
    callingConvention: CallingConvention;
    /** Bytes callee pops on RET (stdcall). Default: params.length * 4. Use when decoration is wrong (e.g. _AIL_file_read@8 takes 3 args but RET 8). */
    stackCleanupBytes?: number;
    async?: boolean;  // Returns a Promise
    /** Failure value when this name has no handler. Default: "zero" (COM methods: "hresult"). */
    onUnimplemented?: UnimplementedReturn;
    category?: string;  // For documentation/grouping
    description?: string;
}

export interface InterfaceDescriptor {
    name: string;
    inherits?: string;  // Parent interface (e.g., "IUnknown")
    iid?: string;  // Interface ID GUID
    methods: FunctionDescriptor[];
}

export interface ModuleDescriptor {
    name: string;
    version?: string;
    description?: string;
    functions: FunctionDescriptor[];
    interfaces?: InterfaceDescriptor[];
    constants?: Record<string, number>;
}

// Struct definitions for marshaling
export interface StructField {
    name: string;
    type: ParameterType;
    offset: number;
    size: number;
    structName?: string;  // For nested structs
}

export interface StructDescriptor {
    name: string;
    size: number;
    fields: StructField[];
}

// Helper type for building modules
export interface APIRegistry {
    modules: Map<string, ModuleDescriptor>;
    structs: Map<string, StructDescriptor>;
    interfaces: Map<string, InterfaceDescriptor>;
}

// Utility function to calculate stack cleanup for stdcall
export function calculateStackCleanup(params: ParameterDescriptor[]): number {
    let size = 0;
    for (const param of params) {
        switch (param.type) {
            case "u8":
            case "i8":
            case "u16":
            case "i16":
            case "u32":
            case "i32":
            case "f32":
            case "ptr":
            case "handle":
            case "string":
            case "wstring":
                size += 4;  // All pushed as 32-bit values on x86
                break;
            case "u64":
            case "i64":
            case "f64":
                size += 8;  // 64-bit values take 8 bytes
                break;
            case "struct":
                size += param.structSize ?? 4;  // Struct passed by pointer or value
                break;
            case "void":
                break;  // No size
        }
    }
    return size;
}

// Utility function to get the number of arguments (for stub generation)
export function getArgCount(params: ParameterDescriptor[]): number {
    return params.length;
}

// Standard IUnknown interface
export const IUnknown: InterfaceDescriptor = {
    name: "IUnknown",
    iid: "00000000-0000-0000-C000-000000000046",
    methods: [
        {
            name: "QueryInterface",
            params: [
                { name: "this", type: "ptr", direction: "in" },
                { name: "riid", type: "ptr", direction: "in" },
                { name: "ppvObject", type: "ptr", direction: "out" }
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            description: "Query for a supported interface"
        },
        {
            name: "AddRef",
            params: [
                { name: "this", type: "ptr", direction: "in" }
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            description: "Increment reference count"
        },
        {
            name: "Release",
            params: [
                { name: "this", type: "ptr", direction: "in" }
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            description: "Decrement reference count"
        }
    ]
};
