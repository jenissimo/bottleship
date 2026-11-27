import { scopeRigToFile } from "./helpers/d3d9-savestate-rig";
import { defineD3D9MainSuite } from "./helpers/d3d9-savestate-suite-main";
import { defineD3D9FailureSuite } from "./helpers/d3d9-savestate-suite-failures";
import { defineD3D9PixelSuite } from "./helpers/d3d9-savestate-suite-pixels";

scopeRigToFile();
defineD3D9MainSuite(true);
defineD3D9FailureSuite(true);
defineD3D9PixelSuite(true);
