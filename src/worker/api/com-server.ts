import type { FunctionDescriptor, InterfaceDescriptor } from './types';
import { IUnknown } from './types';
const method = (name: string, count: number): FunctionDescriptor => ({
    name, params: Array.from({ length: count }, (_, i) => ({ name: 'arg' + i, type: 'ptr' as const })),
    returnType: 'u32', callingConvention: 'stdcall', onUnimplemented: 'hresult',
});
/** Factories belong to a particular DLL/class, so this vtable has no global IID mapping. */
export const hleClassFactoryInterface: InterfaceDescriptor = {
    name: 'IClassFactory', inherits: 'IUnknown',
    methods: [...IUnknown.methods.map(m => ({ ...m })), method('CreateInstance', 4), method('LockServer', 2)],
};
export const hleComServerFunctions: FunctionDescriptor[] = [
    method('DllGetClassObject', 3), method('DllCanUnloadNow', 0),
    method('DllRegisterServer', 0), method('DllUnregisterServer', 0),
];
