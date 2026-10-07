import type { ReadHint, ZipSource } from "./index";

export class BundleVersionError extends Error {}

export interface RangeTransportOptions {
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
}

class RetryableRangeError extends Error {}

/** The deadline covers both headers and body; a stuck body must release its fetch slot. */
export class HttpRangeSource implements ZipSource {
    readonly size: number;
    readonly etag: string | null;
    private closed = false;
    private readonly active = new Set<AbortController>();

    private constructor(
        readonly url: string, size: number, etag: string | null,
        private readonly options: Required<RangeTransportOptions>,
    ) {
        this.size = size;
        this.etag = etag && !etag.startsWith("W/") ? etag : null;
    }

    static async create(url: string, options: RangeTransportOptions = {}): Promise<HttpRangeSource> {
        const opts = {
            timeoutMs: options.timeoutMs ?? 8_000,
            retries: options.retries ?? 2,
            retryDelayMs: options.retryDelayMs ?? 200,
        };
        const probe = new HttpRangeSource(url, 0, null, opts);
        try {
            const head = await probe.fetchBytes({ method: "HEAD" }, false);
            const size = Number(head.headers.get("content-length"));
            if (head.status === 200 && Number.isSafeInteger(size) && size > 0) {
                return new HttpRangeSource(url, size, head.headers.get("etag"), opts);
            }
        } catch { /* servers without HEAD still support Range */ }
        const response = await probe.fetchBytes({ headers: { Range: "bytes=0-0" } }, true);
        const match = /^bytes 0-0\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        const size = Number(match?.[1]);
        if (response.status !== 206 || !match || !Number.isSafeInteger(size) || size <= 0 || response.bytes.length !== 1) {
            throw new Error(`Range requests are required for WGB loading (invalid probe, status ${response.status})`);
        }
        return new HttpRangeSource(url, size, response.headers.get("etag"), opts);
    }

    private async fetchBytes(init: RequestInit, body: boolean, validate?: (bytes: Uint8Array, headers: Headers) => void): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
        for (let attempt = 0; ; attempt++) {
            if (this.closed) throw new Error("HTTP range source closed");
            const controller = new AbortController();
            this.active.add(controller);
            const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
            let retry = false;
            let delay = this.options.retryDelayMs * 2 ** attempt;
            try {
                const response = await fetch(this.url, { ...init, signal: controller.signal, cache: "no-cache" });
                if (response.status === 408 || response.status === 429 || response.status >= 500) {
                    const after = response.headers.get("retry-after");
                    if (after) delay = Math.max(delay, Math.min(1000, Number(after) * 1000 || Date.parse(after) - Date.now()));
                    await response.body?.cancel();
                    throw new RetryableRangeError(`HTTP ${response.status} for ${this.url}`);
                }
                // A server ignoring If-Range may send gigabytes. Reject before consuming it.
                if (body && response.status !== 206) {
                    await response.body?.cancel();
                    if (response.status === 200 && this.etag) throw new BundleVersionError(`WGB version changed: If-Range returned 200 for ${this.url}`);
                    throw new Error(`Range request failed (${response.status}) for ${this.url}`);
                }
                if (body && this.etag && response.headers.get("etag") !== this.etag) {
                    await response.body?.cancel();
                    throw new BundleVersionError(`WGB ETag changed for ${this.url}`);
                }
                const bytes = body ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array(0);
                validate?.(bytes, response.headers);
                return { status: response.status, headers: response.headers, bytes };
            } catch (error) {
                retry = !this.closed && attempt < this.options.retries && (
                    error instanceof RetryableRangeError || error instanceof TypeError || controller.signal.aborted
                );
                if (!retry) throw error;
            } finally {
                clearTimeout(timer);
                this.active.delete(controller);
            }
            if (retry) await new Promise<void>(resolve => setTimeout(resolve, Math.min(1000, delay)));
        }
    }

    async readRange(start: number, end: number, hint?: ReadHint): Promise<Uint8Array> {
        const s = Math.max(0, Math.min(Math.floor(start), this.size));
        const e = Math.max(s, Math.min(Math.floor(end), this.size));
        if (e === s) return new Uint8Array(0);
        const headers: Record<string, string> = { Range: `bytes=${s}-${e - 1}` };
        if (this.etag) headers["If-Range"] = this.etag;
        const init = { headers, priority: hint?.speculative ? "low" : "high" } as RequestInit;
        const result = await this.fetchBytes(init, true, (bytes, responseHeaders) => {
            if (responseHeaders.get("content-range") !== `bytes ${s}-${e - 1}/${this.size}`) {
                throw new BundleVersionError(`Wrong Content-Range for ${this.url}: ${responseHeaders.get("content-range")}`);
            }
            if (bytes.length !== e - s) throw new RetryableRangeError(`Short range read: ${bytes.length}/${e - s} for ${this.url}`);
        });
        return result.bytes;
    }

    close(): void {
        this.closed = true;
        for (const controller of this.active) controller.abort();
    }
}
