/** zlib inner-loop HLE — side-effect registration (picked up by libs/index.ts). */
import { libRegistry } from '../../lib-registry';
import { zlibDescriptor } from './descriptor';

libRegistry.register(zlibDescriptor);
