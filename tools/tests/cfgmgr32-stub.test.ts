import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { unimplementedReturnValue } from "../../src/worker/core/thunking/unimplemented-return";

test.each([
    ["CM_Free_Log_Conf_Handle", 1, 0],
    ["CM_Get_Res_Des_Data", 4, 0x34],
    ["CM_Get_Res_Des_Data_Size", 3, 0x34],
    ["CM_Get_First_Log_Conf", 3, 0x34],
    ["CM_Get_Next_Res_Des", 5, 0x34],
    ["CM_Locate_DevNodeA", 3, 0x34],
] as const)("cfgmgr32!%s emits the correct stdcall cleanup and declares its result", (name, args, result) => {
    const dll = "cfgmgr32";
    const registry = APIRegistry.getInstance();
    const argCount = registry.getArgCount(dll, name);
    const stackCleanupBytes = registry.getStackCleanupBytes(dll, name);
    const callingConvention = registry.getCallingConvention(dll, name);
    const { stubCode } = new ThunkGenerator().generateStubDll(dll, [
        { name, argCount, stackCleanupBytes, callingConvention },
    ]);

    expect(argCount).toBe(args);
    expect(stackCleanupBytes).toBe(args * 4);
    expect(callingConvention).toBe("stdcall");
    expect([...stubCode.slice(11, 14)]).toEqual([0xc2, args * 4, 0]);
    const returnClass = registry.getUnimplementedReturnClass(dll, name);
    expect(returnClass).toBe(result === 0 ? "zero" : "configret");
    expect(unimplementedReturnValue(returnClass!)).toBe(result);
});
