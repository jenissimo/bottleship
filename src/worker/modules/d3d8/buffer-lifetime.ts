/** D3D8 buffers have public COM references and separate device/state-block ownership. */
import type { D3D8DeviceAdapter } from "../../backends/webgpu/d3d8/d3d8-device-adapter";
import { System } from "../../core/system";
import { freeComObject } from "../../core/com/com-memory";
import { forgetComObject, getComRefCount, releaseComRef, resourceToDevice } from "./shared-state";

export type BufferKind = "vb" | "ib";

export function retainBuffer(device: D3D8DeviceAdapter, kind: BufferKind, ptr: number): void {
    const data = (kind === "vb" ? device.vbData : device.ibData).get(ptr);
    if (data) data.internalRefs = (data.internalRefs ?? 0) + 1;
}

export function releaseBuffer(device: D3D8DeviceAdapter, kind: BufferKind, ptr: number): void {
    const data = (kind === "vb" ? device.vbData : device.ibData).get(ptr);
    if (!data) return;
    data.internalRefs = Math.max(0, (data.internalRefs ?? 0) - 1);
    retireBuffer(device, kind, ptr);
}

function retireBuffer(device: D3D8DeviceAdapter, kind: BufferKind, ptr: number): void {
    const store = kind === "vb" ? device.vbData : device.ibData;
    const data = store.get(ptr);
    if (!data || data.internalRefs || getComRefCount(ptr) !== 0) return;
    device.releaseBuffer(kind, ptr);
    const process = System.getInstance().process;
    if (process) process.memory.free(data.guestPtr);
    store.delete(ptr);
    resourceToDevice.delete(ptr);
    forgetComObject(ptr);
    if (process) freeComObject(process.memory, ptr);
}

export function releaseBufferReference(ptr: number, kind: BufferKind): number {
    // Keep the public zero count available for GetStreamSource/GetIndices to AddRef again.
    const refs = releaseComRef(ptr, true);
    if (refs === undefined) return 1;
    const device = resourceToDevice.get(ptr);
    if (refs === 0 && device) retireBuffer(device, kind, ptr);
    return refs;
}
