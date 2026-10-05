/**
 * ffmpeg's entry in the native-module patch registry. The predicate is the module-name pattern
 * for a shipped avcodec import library; everything else (ABI verification, codec support, the
 * decision to serve at all) happens inside the patcher and refuses by leaving the DLL alone.
 */

import { registerNativeModulePatcher } from '../../core/hooks/native-module-patchers';
import { isAvcodecModule, patchAvcodecModule } from './native-patch';

registerNativeModulePatcher({
    id: 'ffmpeg-avcodec',
    matches: isAvcodecModule,
    patch: (process, module) => patchAvcodecModule(process, module),
});
