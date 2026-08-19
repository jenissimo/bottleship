/**
 * Galaxy's entry in the native-module patch registry. No predicate: Galaxy decides for itself
 * (`onNativeModuleLoaded` early-outs when its HLE module is absent, then `shouldPatchGalaxyNative`
 * checks the module name, the integration kind and the version profile), which is exactly the
 * unconditional call the loader used to make.
 */

import { registerNativeModulePatcher } from '../../core/hooks/native-module-patchers';
import { Galaxy } from './index';

registerNativeModulePatcher({
    id: 'galaxy',
    patch: (process, module) => Galaxy.onNativeModuleLoaded(process, module),
});
