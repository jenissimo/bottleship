/**
 * DirectInput device readout. Whether the host captures the pointer is decided by the
 * cooperative level the game asked for and by acquisition — neither of which any
 * screenshot shows, and whose log line is long gone by the time input misbehaves.
 */
import type { HarnessService } from "../service";
import { describeDInputDevices } from "../../modules/dinput/dinput";

export function registerDInputCommands(svc: HarnessService): void {
    svc.register("dinputState", () => ({ devices: describeDInputDevices() }));
}
