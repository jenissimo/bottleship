import type { IModule } from "../../core/module";
import type { Process } from "../../core/process";
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { BaseComObject, ComObjectFactory } from "../../core/com/base-com-object";
import { InterfaceRegistry } from "../../core/com/interface-registry";
import { createVTablesFromDescriptor, type VTableInfo } from "../../api/adapters/module-adapter";
import { HleComServer } from "../../core/com/hle-com-server";
import { dpnlobbyModule } from "../../api/dpnlobby.api";
import type { DirectPlayAddressApi } from "../dpnet/address-api";
import { DirectPlay8LobbyApi } from "./network-api";
import { DPNLOBBY_COM_CLASSES } from "./constants";
import { installDirectPlayRegistration } from "../directplay-registration";
export class Dpnlobby implements IModule {
    name = "dpnlobby";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private tables: Record<string, VTableInfo> = {};
    private api!: DirectPlay8LobbyApi;
    private server!: HleComServer;
    constructor(readonly addresses: () => DirectPlayAddressApi) {}
    get vtables(): Record<string, VTableInfo> { return this.tables; }
    initialize(process: Process): void {
        this.process = process;
        InterfaceRegistry.getInstance().registerFromModuleDescriptor(dpnlobbyModule);
        this.tables = createVTablesFromDescriptor(process, dpnlobbyModule);
        for (const iface of dpnlobbyModule.interfaces ?? []) {
            if (!iface.iid) continue;
            const iid = iface.iid;
            ComObjectFactory.register(iid, class LobbyObject extends BaseComObject {
                constructor(table: number) { super(iid, table); }
                protected destroy(): void {}
            });
        }
        this.api = new DirectPlay8LobbyApi(process, () => this.tables, this.addresses);
        this.api.install(this.exports);
        this.server = new HleComServer(process, dpnlobbyModule, () => this.tables, DPNLOBBY_COM_CLASSES);
        this.server.install(this.exports);
        installDirectPlayRegistration(this.exports, "dpnlobby");
    }
    reset(): void { this.api?.reset(); this.server?.reset(); }
    recreateVTables(): void { this.tables = createVTablesFromDescriptor(this.process, dpnlobbyModule); }
    reregisterExports(process: Process): void { this.process = process; }
}
