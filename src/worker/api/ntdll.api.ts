import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
  const params: ParameterDescriptor[] = [];
  for (let i = 0; i < count; i++) {
    params.push({ name: `arg${i}`, type: "u32" });
  }
  return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
  ...overrides,
  name,
  params: overrides.params ?? buildParams(argCount),
  returnType: overrides.returnType ?? "u32",
  callingConvention: overrides.callingConvention ?? "stdcall",
});

export const ntdllModule: ModuleDescriptor = {
  name: "ntdll",
  functions: [
    makeFunc("RtlInitializeCriticalSection", 1),
    makeFunc("RtlInitializeCriticalSectionAndSpinCount", 2),
    makeFunc("RtlDeleteCriticalSection", 1),
    makeFunc("RtlEnterCriticalSection", 1),
    makeFunc("RtlTryEnterCriticalSection", 1),
    makeFunc("RtlLeaveCriticalSection", 1),
    makeFunc("RtlAllocateHeap", 3),
    makeFunc("RtlFreeHeap", 3),
    makeFunc("RtlReAllocateHeap", 4),
    makeFunc("RtlSizeHeap", 3),
    makeFunc("RtlFreeAnsiString", 1),
    makeFunc("RtlFreeOemString", 1),
    makeFunc("RtlFreeUnicodeString", 1),
    makeFunc("RtlCreateUserThread", 10),
    makeFunc("NtQueueApcThread", 5),
    makeFunc("NtDelayExecution", 2),
  ],
};
