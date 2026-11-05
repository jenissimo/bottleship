import { buildId } from "./smoke-model";

/** Build a smoke run is pinned to — the dev server's commit, or today's date without git. */
export function currentBuild(): string {
  return buildId(typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : undefined, Date.now());
}

export function currentAppVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
}
