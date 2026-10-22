import type { IModule } from "../../core/module";
import type { Process } from "../../core/process";
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { BaseComObject, ComObjectFactory } from "../../core/com/base-com-object";
import { InterfaceRegistry } from "../../core/com/interface-registry";
import { createVTablesFromDescriptor, type VTableInfo } from "../../api/adapters/module-adapter";
import { dpnetModule } from "../../api/dpnet.api";
import { DirectPlayAddressApi } from "./address-api";
import { DirectPlay8NetworkApi } from "./network-api";
import { DirectPlayThreadPoolApi } from "./threadpool-api";
import { HleComServer } from '../../core/com/hle-com-server';
import { installDirectPlayRegistration } from '../directplay-registration';
import { DIRECTPLAY8_COM_CLASSES } from '../directplay-classes';

export class Dpnet implements IModule {
    name = "dpnet";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private tables: Record<string, VTableInfo> = {};
    private addresses!: DirectPlayAddressApi;
    private peers!: DirectPlay8NetworkApi;
    private threadpool!: DirectPlayThreadPoolApi;
    private comServer!: HleComServer;
    get vtables(): Record<string, VTableInfo> { return this.tables; }
    get addressApi(): DirectPlayAddressApi { return this.addresses; }
    initialize(process: Process): void {
        this.process = process;
        InterfaceRegistry.getInstance().registerFromModuleDescriptor(dpnetModule);
        this.tables = createVTablesFromDescriptor(process, dpnetModule);
        for (const iface of dpnetModule.interfaces ?? []) {
            if (!iface.iid) continue;
            const iid = iface.iid;
            ComObjectFactory.register(iid, class DirectPlay8ComObject extends BaseComObject {
                constructor(vtable: number) { super(iid, vtable); }
                protected destroy(): void {}
            });
        }
        this.addresses = new DirectPlayAddressApi(process, () => this.tables);
        this.addresses.install(this.exports);
        this.peers = new DirectPlay8NetworkApi(process, () => this.tables, this.addresses);
        this.peers.install(this.exports);
        this.threadpool = new DirectPlayThreadPoolApi(process, () => this.tables);
        this.threadpool.install(this.exports);
        this.comServer = new HleComServer(process, dpnetModule, () => this.tables, DIRECTPLAY8_COM_CLASSES);
        this.comServer.install(this.exports);
        installDirectPlayRegistration(this.exports, 'dpnet');
    }
    reset(): void { this.peers?.reset(); this.threadpool?.reset(); this.addresses?.reset(); this.comServer?.reset(); }
    recreateVTables(): void { this.tables = createVTablesFromDescriptor(this.process, dpnetModule); }
    reregisterExports(process: Process): void { this.process = process; }
}
