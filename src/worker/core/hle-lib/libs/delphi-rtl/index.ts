/** Delphi RTL record helpers — side-effect registration (picked up by libs/index.ts). */
import { libRegistry } from '../../lib-registry';
import { delphiRtlDescriptor } from './descriptor';

libRegistry.register(delphiRtlDescriptor);
