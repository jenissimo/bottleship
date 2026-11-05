import { useSyncExternalStore } from "react";
import { diskBundleUrl } from "../../utils/bundle-url";
import {
  SMOKE_STORE_KEY,
  parseStore,
  launchUrl,
  type SmokeItem,
  type SmokeStore,
} from "./smoke-model";

/**
 * Browser side of the smoke-run tool: the localStorage-backed store shared by the list
 * modal and the in-game panel, and launching an item.
 *
 * Every launch is a full page load (`?game=<id>` for catalog titles, `?game=dev&load=…`
 * for disk bundles — the same URLs the library and the Add-Game flow navigate to), so
 * back-to-back games never share a worker. Which item the tab is smoking survives that
 * load in sessionStorage.
 */

const ACTIVE_KEY = "bs.smoke-run.active";

let cached: SmokeStore | null = null;
const listeners = new Set<() => void>();

function read(): SmokeStore {
  if (cached) return cached;
  try { cached = parseStore(localStorage.getItem(SMOKE_STORE_KEY)); } catch { cached = parseStore(null); }
  return cached;
}

function emit(): void {
  for (const l of listeners) l();
}

export function getSmokeStore(): SmokeStore {
  return read();
}

export function updateSmokeStore(fn: (s: SmokeStore) => SmokeStore): void {
  const next = fn(read());
  if (next === cached) return;
  cached = next;
  try { localStorage.setItem(SMOKE_STORE_KEY, JSON.stringify(next)); } catch { /* quota — keep in memory */ }
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  // Another tab of the same dev server edited the run.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SMOKE_STORE_KEY) return;
    cached = null;
    l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSmokeStore(): SmokeStore {
  return useSyncExternalStore(subscribe, read);
}

// ---------------------------------------------------------------------------
// Active item (per tab)

export interface SmokeActive {
  source: string;
  key: string;
}

export function getActive(): SmokeActive | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    return raw ? (JSON.parse(raw) as SmokeActive) : null;
  } catch { return null; }
}

export function clearActive(): void {
  try { sessionStorage.removeItem(ACTIVE_KEY); } catch { /* nothing to clear */ }
  emit();
}

export async function launchSmokeItem(sourceKey: string, item: SmokeItem): Promise<void> {
  try { sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({ source: sourceKey, key: item.key } satisfies SmokeActive)); } catch { /* panel just won't show */ }
  const bundle = item.launch.kind === "disk" ? (await diskBundleUrl(item.launch.path)).url : null;
  window.location.assign(launchUrl(item, bundle));
}
