/** A stable Worker endpoint for UI consumers; the root remains alive as the VFS broker. */
export class SessionWorker extends EventTarget implements Worker {
    onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
    onmessageerror: ((this: Worker, ev: MessageEvent) => any) | null = null;
    onerror: ((this: AbstractWorker, ev: ErrorEvent) => any) | null = null;
    private foreground: MessagePort | null = null;
    private ports = new Set<MessagePort>();
    private requests = new Map<unknown, MessagePort | null>();
    private settings = new Map<string, any>();
    private sources = new WeakMap<MessageEvent, Worker | MessagePort>();
    replyTarget(event: MessageEvent): Worker | MessagePort { return this.sources.get(event) ?? this.root; }

    constructor(private root: Worker) {
        super();
        this.addEventListener('message', event => this.onmessage?.call(this, event as MessageEvent));
        root.onmessage = event => this.receive(event, null);
        root.onmessageerror = event => { this.onmessageerror?.call(this, event); this.dispatchEvent(new MessageEvent('messageerror', { data: event.data })); };
        root.onerror = event => { this.onerror?.call(this, event); };
    }

    private receive(event: MessageEvent, source: MessagePort | null): void {
        const reply = event.data?.type === 'harness_reply' && this.requests.has(event.data.id)
            && this.requests.get(event.data.id) === source;
        if (reply) this.requests.delete(event.data.id);
        if (source !== this.foreground && source !== null && !reply) return;
        if (event.data?.type === 'child_session') {
            const port = event.data.port as MessagePort;
            this.foreground = port;
            this.ports.add(port);
            port.onmessage = next => this.receive(next, port);
            for (const setting of this.settings.values()) port.postMessage(setting);
        } else if (source !== this.foreground && !reply) return;
        const message = new MessageEvent('message', { data: event.data, ports: [...event.ports] });
        this.sources.set(message, source ?? this.root);
        this.dispatchEvent(message);
        // A promoted child that has exited is about to be terminated by its parent, so
        // leaving the channel pointed at it turns every later harness call into a post
        // into a dead port — which reads as "the RPC died" and is unrecoverable short of
        // a page reload. Exit is when a post-mortem is wanted most. The root worker
        // outlives the child (it stays up as its VFS broker) and holds the child's
        // record, so the channel falls back there. `broker` is the PARENT's own exit
        // relayed through the child's port, not the child's.
        if (event.data?.type === 'process_exit' && source !== null && source === this.foreground
            && !event.data.broker) {
            this.retireForeground();
        }
    }

    /** Point the channel back at the root and settle anything still addressed to the
     *  retired port — a caller must be told, not left to time out. */
    private retireForeground(): void {
        const retired = this.foreground;
        if (!retired) return;
        this.foreground = null;
        for (const [id, target] of [...this.requests]) {
            if (target !== retired) continue;
            this.requests.delete(id);
            const dead = new MessageEvent('message', {
                data: {
                    type: 'harness_reply', id, ok: false,
                    error: {
                        code: 'CRASHED',
                        message: 'the child session exited while this call was in flight — '
                            + 'the harness now targets the parent worker; its childProcesses() '
                            + 'holds the exited child’s record, logs and fault',
                    },
                },
            });
            this.sources.set(dead, this.root);
            this.dispatchEvent(dead);
        }
        const reset = new MessageEvent('message', { data: { type: 'child_session_reset' } });
        this.sources.set(reset, this.root);
        this.dispatchEvent(reset);
    }

    postMessage(message: any, options: Transferable[] | StructuredSerializeOptions = []): void {
        if (message?.type === 'load_bundle' || message?.type === 'load_pe') {
            for (const port of this.ports) port.close();
            this.ports.clear();
            this.requests.clear();
            this.foreground = null;
            const reset = new MessageEvent('message', { data: { type: 'child_session_reset' } });
            this.dispatchEvent(reset);
        }
        if (['set_session', 'set_quality', 'set_debug_flag', 'logging_global_enable'].includes(message?.type)) {
            this.settings.set(`${message.type}:${message.key ?? ''}`, message);
        }
        // `target:'root'` addresses the ROOT worker even while a child holds the
        // foreground. The parent keeps running (VFS broker) and owns the history a
        // promoted child's realm cannot see — its own childProcesses(), its thunk ring,
        // its VFS. Without an address for it that state is merely unreachable, not gone.
        const toRoot = message?.type === 'harness_rpc' && message?.opts?.target === 'root';
        if (message?.type === 'harness_rpc') this.requests.set(message.id, toRoot ? null : this.foreground);
        if (toRoot) { this.root.postMessage(message, options as Transferable[]); return; }
        if (message?.type === 'harness_cancel' && this.requests.has(message.id)) {
            (this.requests.get(message.id) ?? this.root).postMessage(message);
            return;
        }
        // The original canvas remains the input/layout anchor. Its backing dimensions
        // still follow host resize even while another canvas supplies the visible image.
        if (this.foreground && message?.type === 'resize') this.root.postMessage(message);
        (this.foreground ?? this.root).postMessage(message, options as Transferable[]);
    }

    terminate(): void {
        for (const port of this.ports) port.close();
        this.ports.clear(); this.requests.clear(); this.foreground = null; this.root.terminate();
    }
}
