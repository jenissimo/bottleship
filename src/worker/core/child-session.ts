type Post = (message: any, transfer?: Transferable[]) => void;

/** The parent always serves I/O/lifetime; the foreground page port owns UI and input. */
export class ChildSessionTransport {
    private port: MessagePort | null = null;
    private pending: any[] = [];
    constructor(private parent: Post, private receive: (event: MessageEvent) => void) {}

    post(message: any, transfer: Transferable[] = []): void {
        if (message.type === 'child_io' || message.type === 'child_animation_request') { this.parent(message, transfer); return; }
        if (message.type === 'process_exit' && message.broker) { this.parent(message, transfer); return; }
        if (!this.port && message.type === 'child_session') { this.parent(message, transfer); return; }
        const lifetime = ['process_exit', 'error', 'crash', 'window_title'].includes(message.type);
        if (this.port) {
            if (lifetime) this.parent(message);
            this.port.postMessage(message, transfer);
            return;
        }
        // Control messages still reach the runner before a window claims the display.
        this.parent(message);
        if (message.type?.startsWith('log_')) return;
        // Keep initial display/audio state until the page takes over. No transferred
        // buffers are detached here: these messages may be needed only once, on attach.
        if (this.pending.length >= 4096) throw new Error('Child UI queue exceeded 4096 messages before session attachment');
        this.pending.push(message);
    }

    attach(port: MessagePort): void {
        if (this.port) throw new Error('Child session already attached');
        this.port = port;
        port.onmessage = this.receive;
        for (const message of this.pending) port.postMessage(message);
        this.pending.length = 0;
    }
}
