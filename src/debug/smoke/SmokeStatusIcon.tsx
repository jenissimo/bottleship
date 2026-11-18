import { Check, FastForward, Minus, X } from "@phosphor-icons/react";
import type { SmokeStatus } from "./smoke-model";

const icons = { untested: Minus, ok: Check, regression: X, skip: FastForward };

export function SmokeStatusIcon({ status }: { status: SmokeStatus }) {
    const Icon = icons[status];
    return <Icon size="1em" weight="bold" aria-hidden />;
}
