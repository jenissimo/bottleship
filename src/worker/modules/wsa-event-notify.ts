import { System } from "../core/system";
import type { WsaEventNotifier, WsaEventTarget } from "./wsa-network";

export function wsaEventNotifier(socket: number, target: WsaEventTarget): WsaEventNotifier {
    if (target.kind === "window") {
        return (bit, error) => {
            const system = System.getInstance();
            system.windowManager.postMessage(target.hwnd, target.message, socket, ((error << 16) | bit) >>> 0);
            system.scheduler.wakeMessageWaiters();
        };
    }
    return () => { System.getInstance().scheduler.setEvent(target.handle); };
}
