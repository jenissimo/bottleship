/**
 * Code Generation Utilities for API Descriptors
 *
 * Generates:
 * - Stub DLL specifications
 * - VTable specifications
 * - Thunk registration code
 * - Argument marshaling helpers
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
    calculateStackCleanup,
    getArgCount,
} from "./types";
import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import { EmulatorConfig, getCodePageDecoder } from "../core/emulator-config-manager";
import { asBufferSource } from "../../dom-buffer";
import { toPlainGuestMemory } from "../core/memory/guest-memory";

export interface StubSpec {
    name: string;
    argCount: number;
    stackCleanup: number;
}

export interface VTableSpec {
    name: string;
    methods: StubSpec[];
}

/**
 * Generate stub specifications for a module's exported functions
 */
export function generateStubDllSpec(module: ModuleDescriptor): StubSpec[] {
    return module.functions.map(func => {
        const stackCleanup = func.callingConvention === "stdcall"
            ? calculateStackCleanup(func.params)
            : 0;
        return {
            name: func.name,
            argCount: stackCleanup >> 2,
            stackCleanup,
        };
    });
}

/**
 * Generate VTable specification for a COM interface
 */
export function generateVTableSpec(iface: InterfaceDescriptor): VTableSpec {
    return {
        name: iface.name,
        methods: iface.methods.map(method => {
            const stackCleanup = method.callingConvention === "stdcall"
                ? calculateStackCleanup(method.params)
                : 0;
            return {
                name: `${iface.name}_${method.name}`,
                argCount: stackCleanup >> 2,
                stackCleanup,
            };
        }),
    };
}

/**
 * Generate VTable specifications for a module (all interfaces)
 */
export function generateModuleVTables(module: ModuleDescriptor): VTableSpec[] {
    if (!module.interfaces) return [];
    return module.interfaces.map(iface => generateVTableSpec(iface));
}

/**
 * Generate type-safe argument marshaling shim for a function
 */
export function generateFunctionShim(func: FunctionDescriptor, implName: string): string {
    const lines: string[] = [];
    const funcName = `${func.name}Shim`;

    // Function signature
    lines.push(`function ${funcName}(ctx: X86Context, mem: Uint8Array, args: number[]): number | Promise<number> {`);

    // Argument marshaling
    if (func.params.length > 0) {
        lines.push(`    // Marshal arguments`);
        for (let i = 0; i < func.params.length; i++) {
            const param = func.params[i];
            const marshaler = generateParamMarshaler(param, i);
            lines.push(`    const ${param.name} = ${marshaler};`);
        }
    }

    // Function call
    const argNames = func.params.map(p => p.name).join(', ');
    if (func.returnType === 'void') {
        lines.push(`    ${implName}(${argNames});`);
        lines.push(`    return 0;`);
    } else {
        if (func.async) {
            lines.push(`    return ${implName}(${argNames});`);
        } else {
            lines.push(`    const result = ${implName}(${argNames});`);
            lines.push(`    return typeof result === 'number' ? result : 0;`);
        }
    }

    lines.push(`}`);
    lines.push("");

    return lines.join("\n");
}

/**
 * Generate COM method shim with 'this' pointer handling
 */
export function generateComMethodShim(ifaceName: string, method: FunctionDescriptor, implName: string): string {
    const lines: string[] = [];
    const funcName = `${ifaceName}_${method.name}Shim`;

    // Function signature
    lines.push(`function ${funcName}(ctx: X86Context, mem: Uint8Array, args: number[]): number | Promise<number> {`);

    // Get 'this' pointer (first argument)
    lines.push(`    const thisPtr = args[0];`);
    lines.push(`    const comObj = System.getInstance().comResourceManager.getComObject(thisPtr);`);
    lines.push(`    if (!comObj) {`);
    lines.push(`        Logger.error(LogCategory.COM, 'Invalid COM object handle: 0x' + thisPtr.toString(16));`);
    lines.push(`        return 0x80004005; // E_FAIL`);
    lines.push(`    }`);

    // Argument marshaling (skip 'this' pointer)
    if (method.params.length > 1) {
        lines.push(`    // Marshal arguments`);
        for (let i = 1; i < method.params.length; i++) {
            const param = method.params[i];
            const marshaler = generateParamMarshaler(param, i);
            lines.push(`    const ${param.name} = ${marshaler};`);
        }
    }

    // Method call
    const argNames = method.params.slice(1).map(p => p.name).join(', ');
    const methodCall = `comObj.${method.name}(${argNames})`;

    if (method.returnType === 'void') {
        lines.push(`    ${methodCall};`);
        lines.push(`    return 0;`);
    } else {
        if (method.async) {
            lines.push(`    return ${methodCall};`);
        } else {
            lines.push(`    const result = ${methodCall};`);
            lines.push(`    return typeof result === 'number' ? result : 0;`);
        }
    }

    lines.push(`}`);
    lines.push("");

    return lines.join("\n");
}

/**
 * Generate complete module shims (type-safe argument marshaling)
 */
export function generateModuleShims(module: ModuleDescriptor): string {
    const lines: string[] = [];

    lines.push(`// Auto-generated shims for ${module.name}`);
    lines.push(`// Provides type-safe argument marshaling`);
    lines.push("");
    lines.push(`import { X86Context } from "../core/thunk-dispatcher";`);
    lines.push(`import { System } from "../core/system";`);
    lines.push(`import { Logger, LogCategory } from "../core/logger";`);
    lines.push(`import * as impl from "./${module.name}.impl";`);
    lines.push("");

    // Generate function shims
    for (const func of module.functions) {
        const shimCode = generateFunctionShim(func, `impl.${func.name}`);
        lines.push(shimCode);
    }

    // Generate COM method shims
    if (module.interfaces) {
        for (const iface of module.interfaces) {
            for (const method of iface.methods) {
                const shimCode = generateComMethodShim(iface.name, method, `impl.${iface.name}_${method.name}`);
                lines.push(shimCode);
            }
        }
    }

    // Export shim functions
    lines.push("// Export shims for thunk registration");
    lines.push("export const shims = {");

    for (const func of module.functions) {
        lines.push(`    ${func.name}: ${func.name}Shim,`);
    }

    if (module.interfaces) {
        for (const iface of module.interfaces) {
            for (const method of iface.methods) {
                const fullName = `${iface.name}_${method.name}`;
                lines.push(`    ${fullName}: ${fullName}Shim,`);
            }
        }
    }

    lines.push("};");

    return lines.join("\n");
}

/**
 * Generate thunk registration code using shims
 */
export function generateThunkRegistrations(
    module: ModuleDescriptor,
    implModulePath: string
): string {
    const lines: string[] = [];

    lines.push(`// Auto-generated thunk registrations for ${module.name}`);
    lines.push(`// Uses generated shims for type-safe marshaling`);
    lines.push("");
    lines.push(`import { ThunkDispatcher } from "../core/thunk-dispatcher";`);
    lines.push(`import { shims } from "./${module.name}.shims";`);
    lines.push("");
    lines.push(`export function register${capitalize(module.name)}Thunks(dispatcher: ThunkDispatcher): void {`);

    // Register functions
    for (const func of module.functions) {
        lines.push(`    dispatcher.register("${module.name}", "${func.name}", shims.${func.name});`);
    }

    // Register interface methods
    if (module.interfaces) {
        for (const iface of module.interfaces) {
            for (const method of iface.methods) {
                const fullName = `${iface.name}_${method.name}`;
                lines.push(`    dispatcher.register("${module.name}", "${fullName}", shims.${fullName});`);
            }
        }
    }

    lines.push(`}`);

    return lines.join("\n");
}

/**
 * Generate argument marshaling helper for a function
 */
export function generateArgumentMarshaler(func: FunctionDescriptor): string {
    const lines: string[] = [];
    const typeName = `${func.name}Args`;

    // Generate interface for typed arguments
    lines.push(`interface ${typeName} {`);
    for (const param of func.params) {
        const tsType = paramTypeToTs(param);
        lines.push(`    ${param.name}: ${tsType};`);
    }
    lines.push(`}`);
    lines.push("");

    // Generate marshaling function
    lines.push(`function marshal_${func.name}(mem: Uint8Array, args: number[]): ${typeName} {`);
    lines.push(`    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);`);
    lines.push(`    return {`);

    for (let i = 0; i < func.params.length; i++) {
        const param = func.params[i];
        const marshaler = generateParamMarshaler(param, i);
        lines.push(`        ${param.name}: ${marshaler},`);
    }

    lines.push(`    };`);
    lines.push(`}`);

    return lines.join("\n");
}

/**
 * Generate STDCALL_ARGS record for a module
 */
export function generateStdcallArgs(module: ModuleDescriptor): Record<string, number> {
    const result: Record<string, number> = {};

    for (const func of module.functions) {
        result[func.name] = calculateStackCleanup(func.params) >> 2;
    }

    if (module.interfaces) {
        for (const iface of module.interfaces) {
            for (const method of iface.methods) {
                const fullName = `${iface.name}_${method.name}`;
                result[fullName] = calculateStackCleanup(method.params) >> 2;
            }
        }
    }

    return result;
}

// Helper functions

function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function paramTypeToTs(param: ParameterDescriptor): string {
    switch (param.type) {
        case "u8":
        case "i8":
        case "u16":
        case "i16":
        case "u32":
        case "i32":
        case "f32":
        case "f64":
        case "ptr":
        case "handle":
            return "number";
        case "u64":
        case "i64":
            return "bigint";
        case "string":
        case "wstring":
            return "string";
        case "struct":
            return param.structName ?? "Uint8Array";
        case "void":
            return "void";
        default:
            return "unknown";
    }
}

function generateParamMarshaler(param: ParameterDescriptor, argIndex: number): string {
    switch (param.type) {
        case "u8":
            return `args[${argIndex}] & 0xFF`;
        case "i8":
            return `(args[${argIndex}] << 24) >> 24`;
        case "u16":
            return `args[${argIndex}] & 0xFFFF`;
        case "i16":
            return `(args[${argIndex}] << 16) >> 16`;
        case "u32":
        case "ptr":
        case "handle":
            return `args[${argIndex}] >>> 0`;
        case "i32":
            return `args[${argIndex}] | 0`;
        case "f32":
            return `view.getFloat32(args[${argIndex}], true)`;
        case "u64":
            return `view.getBigUint64(args[${argIndex}], true)`;
        case "i64":
            return `view.getBigInt64(args[${argIndex}], true)`;
        case "f64":
            return `view.getFloat64(args[${argIndex}], true)`;
        case "string":
            return `readString(mem, args[${argIndex}])`;
        case "wstring":
            return `readWideString(mem, args[${argIndex}])`;
        case "struct": {
            const size = param.structSize ?? 0;
            return `mem.slice(args[${argIndex}], args[${argIndex}] + ${size})`;
        }
        default:
            return `args[${argIndex}]`;
    }
}

/**
 * Read ANSI null-terminated string from memory
 */
export function readString(mem: Uint8Array, ptr: number): string {
    if (ptr === 0) return "";
    // A thunk's `mem` is v86's Proxy; scanning it per byte (and re-reading `.length`
    // through the trap each iteration) is the slow arm this normalizer exists for.
    mem = toPlainGuestMemory(mem);
    const len = mem.length;
    let end = ptr;
    while (mem[end] !== 0 && end < len) end++;
    return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage)
        .decode(asBufferSource(mem.subarray(ptr, end)));
}

/**
 * Read UTF-16LE null-terminated string from memory
 */
export function readWideString(mem: Uint8Array, ptr: number): string {
    if (ptr === 0) return "";
    mem = toPlainGuestMemory(mem);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const stop = mem.length - 1;
    let end = ptr;
    while (end < stop && view.getUint16(end, true) !== 0) {
        end += 2;
    }
    return new TextDecoder("utf-16le").decode(mem.subarray(ptr, end));
}
