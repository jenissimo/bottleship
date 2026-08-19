/**
 * Registration barrel for real-DLL export patchers. Importing this file is what puts the
 * entries in the registry; the loader imports only `runNativeModulePatchers` from here, so it
 * never names a library. Add a library by adding its side-effect import below.
 */

import './galaxy/patch-entry';
import './ffmpeg/patch-entry';

export { runNativeModulePatchers } from '../core/hooks/native-module-patchers';
