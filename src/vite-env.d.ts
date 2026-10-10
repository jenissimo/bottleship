/// <reference types="vite/client" />

/** Short git commit of the build, injected by vite `define` (see vite.config.ts). */
declare const __BUILD_SHA__: string;

/** Release version from the root package.json, injected by vite. */
declare const __APP_VERSION__: string;
