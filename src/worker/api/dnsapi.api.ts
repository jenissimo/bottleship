import { FunctionDescriptor, ModuleDescriptor, ParameterDescriptor } from "./types";

const dwords = (count: number): ParameterDescriptor[] =>
    Array.from({ length: count }, (_, i) => ({ name: `arg${i}`, type: "u32" as const }));

// DnsQuery_* answers with a DNS_STATUS (a Win32 error code, 0 = success), so a stub that
// answered zero would tell the caller its untouched record pointer is a result list.
const query = (name: string): FunctionDescriptor => ({
    name, params: dwords(6), returnType: "u32", callingConvention: "stdcall", onUnimplemented: "win32Status",
});
const free = (name: string): FunctionDescriptor => ({
    name, params: dwords(2), returnType: "void", callingConvention: "stdcall",
});

export const dnsapiModule: ModuleDescriptor = {
    name: "dnsapi",
    description: "DNS client API",
    functions: [
        query("DnsQuery_A"),
        query("DnsQuery_W"),
        query("DnsQuery_UTF8"),
        free("DnsFree"),
        free("DnsRecordListFree"),
    ],
};
