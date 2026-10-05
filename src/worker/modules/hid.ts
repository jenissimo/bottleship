/**
 * HID.DLL — the user-mode half of the Windows HID class driver.
 *
 * Faithful to a real Windows machine with NO HID devices attached, which is what our device
 * layer actually is: HID device paths are handed out by SetupAPI, and setupapi.ts enumerates
 * no HID interfaces (SetupDiEnumDeviceInterfaces answers ERROR_NO_MORE_ITEMS unconditionally).
 * A guest can therefore never obtain an open HID interface handle, so every device- and
 * descriptor-dependent export here is unreachable in practice and fails honestly if reached.
 *
 * Existing at all is the point. On real Windows LoadLibrary("hid.dll") SUCCEEDS, and engines
 * read the failure as "not yet — try again": SDL2's HIDAPI backend re-runs hid_init(), and so
 * the LoadLibrary, on every gamepad-hotplug poll — once per frame, forever. Answering the
 * truthful "the DLL is here, there are no devices" ends that loop instead of feeding it.
 *
 * The one genuinely device-independent function is HidD_GetHidGuid, and it gets the real class
 * GUID. Everything else returns FALSE, or the documented HIDP_STATUS_*, rather than invented
 * capability data: a caller handed fabricated HIDP_CAPS goes on to parse a report descriptor
 * that does not exist, which is far worse for it than a clean refusal.
 *
 * Exports are spelled out one per line rather than assigned from a name list, so
 * validate-signatures can see — and check — every one against hid.api.ts.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Logger, LogCategory } from "../core/logger";

const FALSE = 0;

/** NTSTATUS from FACILITY_HID_ERROR_CODE (0x11): severity | facility << 16 | code. */
const HIDP_STATUS_INVALID_PREPARSED_DATA = 0xc0110001;

/** GUID_DEVINTERFACE_HID — {4D1E55B2-F16F-11CF-88CB-001111000030}. */
const GUID_DEVINTERFACE_HID = {
    d1: 0x4d1e55b2,
    d2: 0xf16f,
    d3: 0x11cf,
    d4: [0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30] as const,
};

/**
 * Reaching a device export means a HID interface handle was obtained after all, which our
 * SetupAPI cannot produce today. Worth one warning rather than silence: it would mean the
 * enumeration side started answering and this module has to grow with it.
 */
const noDevice = (name: string): ThunkImplementation => () => {
    Logger.warn(LogCategory.KERNEL32,
        `hid:${name}: no HID interface is enumerable, so this handle cannot be one — FALSE`);
    return FALSE;
};

/** HidD_GetPreparsedData never succeeds, so no caller can hold valid preparsed data. */
const noPreparsedData = (name: string): ThunkImplementation => () => {
    Logger.warn(LogCategory.KERNEL32,
        `hid:${name}: preparsed data cannot exist — HIDP_STATUS_INVALID_PREPARSED_DATA`);
    return HIDP_STATUS_INVALID_PREPARSED_DATA;
};

export class Hid implements IModule {
    name = "hid";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        const exports = this.exports;

        exports["HidD_GetHidGuid"] = (_ctx, _mem, args) => {
            const guidPtr = args[0] >>> 0;
            if (!guidPtr) return 0;
            Mem.writeUint32(guidPtr, GUID_DEVINTERFACE_HID.d1);
            Mem.writeUint16(guidPtr + 4, GUID_DEVINTERFACE_HID.d2);
            Mem.writeUint16(guidPtr + 6, GUID_DEVINTERFACE_HID.d3);
            for (let i = 0; i < GUID_DEVINTERFACE_HID.d4.length; i++) {
                Mem.writeUint8(guidPtr + 8 + i, GUID_DEVINTERFACE_HID.d4[i]!);
            }
            return 0; // void
        };

        // Freeing what was never allocated: the pointer could only have come from a failed
        // HidD_GetPreparsedData, so there is nothing to release.
        exports["HidD_FreePreparsedData"] = () => FALSE;

        exports["HidD_FlushQueue"] = noDevice("HidD_FlushQueue");
        exports["HidD_GetAttributes"] = noDevice("HidD_GetAttributes");
        exports["HidD_GetFeature"] = noDevice("HidD_GetFeature");
        exports["HidD_GetIndexedString"] = noDevice("HidD_GetIndexedString");
        exports["HidD_GetInputReport"] = noDevice("HidD_GetInputReport");
        exports["HidD_GetManufacturerString"] = noDevice("HidD_GetManufacturerString");
        exports["HidD_GetNumInputBuffers"] = noDevice("HidD_GetNumInputBuffers");
        exports["HidD_GetPhysicalDescriptor"] = noDevice("HidD_GetPhysicalDescriptor");
        exports["HidD_GetPreparsedData"] = noDevice("HidD_GetPreparsedData");
        exports["HidD_GetProductString"] = noDevice("HidD_GetProductString");
        exports["HidD_GetSerialNumberString"] = noDevice("HidD_GetSerialNumberString");
        exports["HidD_SetFeature"] = noDevice("HidD_SetFeature");
        exports["HidD_SetNumInputBuffers"] = noDevice("HidD_SetNumInputBuffers");
        exports["HidD_SetOutputReport"] = noDevice("HidD_SetOutputReport");

        exports["HidP_GetButtonCaps"] = noPreparsedData("HidP_GetButtonCaps");
        exports["HidP_GetCaps"] = noPreparsedData("HidP_GetCaps");
        exports["HidP_GetData"] = noPreparsedData("HidP_GetData");
        exports["HidP_GetLinkCollectionNodes"] = noPreparsedData("HidP_GetLinkCollectionNodes");
        exports["HidP_GetScaledUsageValue"] = noPreparsedData("HidP_GetScaledUsageValue");
        exports["HidP_GetSpecificButtonCaps"] = noPreparsedData("HidP_GetSpecificButtonCaps");
        exports["HidP_GetSpecificValueCaps"] = noPreparsedData("HidP_GetSpecificValueCaps");
        exports["HidP_GetUsageValue"] = noPreparsedData("HidP_GetUsageValue");
        exports["HidP_GetUsageValueArray"] = noPreparsedData("HidP_GetUsageValueArray");
        exports["HidP_GetUsages"] = noPreparsedData("HidP_GetUsages");
        exports["HidP_GetUsagesEx"] = noPreparsedData("HidP_GetUsagesEx");
        exports["HidP_GetValueCaps"] = noPreparsedData("HidP_GetValueCaps");
        exports["HidP_InitializeReportForID"] = noPreparsedData("HidP_InitializeReportForID");
        // These two return a ULONG COUNT, not an NTSTATUS: handing back HIDP_STATUS_INVALID_
        // PREPARSED_DATA (0xC0110001) would be read as ~3.2 billion entries and sized into a
        // malloc. With no preparsed data the honest count is zero.
        exports["HidP_MaxDataListLength"] = () => 0;
        exports["HidP_MaxUsageListLength"] = () => 0;
        exports["HidP_SetData"] = noPreparsedData("HidP_SetData");
        exports["HidP_SetScaledUsageValue"] = noPreparsedData("HidP_SetScaledUsageValue");
        exports["HidP_SetUsageValue"] = noPreparsedData("HidP_SetUsageValue");
        exports["HidP_SetUsageValueArray"] = noPreparsedData("HidP_SetUsageValueArray");
        exports["HidP_SetUsages"] = noPreparsedData("HidP_SetUsages");
        exports["HidP_TranslateUsagesToI8042ScanCodes"] = noPreparsedData("HidP_TranslateUsagesToI8042ScanCodes");
        exports["HidP_UnsetUsages"] = noPreparsedData("HidP_UnsetUsages");
    }
}
