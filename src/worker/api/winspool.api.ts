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

export const winspoolModule: ModuleDescriptor = {
    name: "winspool.drv",
    functions: [
        // OpenPrinterA(pPrinterName, phPrinter, pDefault)
        makeFunc("OpenPrinterA", 3),
        makeFunc("OpenPrinterW", 3),

        // ClosePrinter(hPrinter)
        makeFunc("ClosePrinter", 1),

        // DocumentPropertiesA(hWnd, hPrinter, pDeviceName, pDevModeOutput, pDevModeInput, fMode)
        makeFunc("DocumentPropertiesA", 6),
        makeFunc("DocumentPropertiesW", 6),

        // GetPrinterA(hPrinter, Level, pPrinter, cbBuf, pcbNeeded)
        makeFunc("GetPrinterA", 5),
        makeFunc("GetPrinterW", 5),

        // EnumPrintersA(Flags, Name, Level, pPrinterEnum, cbBuf, pcbNeeded, pcReturned)
        makeFunc("EnumPrintersA", 7),
        makeFunc("EnumPrintersW", 7),

        // GetDefaultPrinterA(pszBuffer, pcchBuffer)
        makeFunc("GetDefaultPrinterA", 2),
        makeFunc("GetDefaultPrinterW", 2),
    ]
};
