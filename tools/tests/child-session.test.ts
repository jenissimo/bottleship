import { expect, test } from 'bun:test';
import { ChildSessionTransport } from '../../src/worker/core/child-session';
import { SessionWorker } from '../../src/app/session-worker';
import { ChildFrameClock } from '../../src/worker/core/child-frame-clock';
import { WebGPUBackend } from '../../src/worker/backends/webgpu/webgpu-backend';

async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(predicate()).toBe(true);
}

test('child UI switches to the page while VFS and process lifetime stay with the parent', async () => {
    const parent: any[] = [], page: any[] = [], input: any[] = [];
    const channel = new MessageChannel();
    channel.port2.onmessage = event => page.push(event.data);
    const bridge = new ChildSessionTransport(message => parent.push(message), event => input.push(event.data));
    try {
        bridge.post({ type: 'window_title', title: 'Already running' });
        bridge.post({ type: 'app_resize', width: 640, height: 480 });
        bridge.attach(channel.port1);
        bridge.post({ type: 'child_io', request: 1 });
        bridge.post({ type: 'cursor_visibility', visible: true });
        channel.port2.postMessage({ type: 'keydown', key: 'Space' });
        await until(() => page.length === 3 && input.length === 1);
        expect(page.map(m => m.type)).toEqual(['window_title', 'app_resize', 'cursor_visibility']);
        expect(parent.at(-1).type).toBe('child_io');
        bridge.post({ type: 'process_exit', exitCode: 71 });
        await until(() => page.length === 4);
        expect(parent.at(-1).exitCode).toBe(71);
        expect(page.at(-1).exitCode).toBe(71);
    } finally { channel.port1.close(); channel.port2.close(); }
});

test('stable host endpoint routes input/RPC to the child and returns to the root on load', async () => {
    const rootMessages: any[] = [], childMessages: any[] = [], output: any[] = [];
    const root = { onmessage: null, postMessage(message: any) { rootMessages.push(message); }, terminate() {} } as unknown as Worker;
    const endpoint = new SessionWorker(root);
    endpoint.addEventListener('message', event => output.push((event as MessageEvent).data));
    const channel = new MessageChannel();
    channel.port2.onmessage = event => childMessages.push(event.data);
    try {
        root.onmessage!.call(root, new MessageEvent('message', { data: { type: 'child_session', port: channel.port1 } }));
        root.onmessage!.call(root, new MessageEvent('message', { data: { type: 'process_exit', exitCode: 0 } }));
        endpoint.postMessage({ type: 'harness_rpc', id: 17 });
        endpoint.postMessage({ type: 'resize', width: 900, height: 600 });
        await until(() => childMessages.length === 2);
        expect(childMessages[0].id).toBe(17);
        expect(rootMessages.map(m => m.type)).toEqual(['resize']);
        expect(output.map(m => m.type)).toEqual(['child_session']);
        channel.port2.postMessage({ type: 'harness_result', id: 17 });
        await until(() => output.length === 2);
        endpoint.postMessage({ type: 'load_bundle', url: 'next.wgb' });
        expect(rootMessages.at(-1).type).toBe('load_bundle');
        expect(output.at(-1).type).toBe('child_session_reset');
    } finally { endpoint.terminate(); channel.port2.close(); }
});

test('in-flight RPC replies keep their original owner across session attachment', async () => {
    const sent: any[] = [], received: any[] = [];
    const root = { onmessage: null, postMessage(m: any) { sent.push(m); }, terminate() {} } as unknown as Worker;
    const endpoint = new SessionWorker(root);
    endpoint.onmessage = event => received.push(event.data);
    const channel = new MessageChannel();
    try {
        endpoint.postMessage({ type: 'harness_rpc', id: 5 });
        root.onmessage!.call(root, new MessageEvent('message', { data: { type: 'child_session', port: channel.port1 } }));
        endpoint.postMessage({ type: 'harness_cancel', id: 5 });
        expect(sent.at(-1).type).toBe('harness_cancel');
        root.onmessage!.call(root, new MessageEvent('message', { data: { type: 'harness_reply', id: 5, ok: true } }));
        expect(received.at(-1).id).toBe(5);
        root.onmessage!.call(root, new MessageEvent('message', { data: { type: 'harness_reply', id: 6, ok: true } }));
        expect(received.at(-1).id).toBe(5);
    } finally { endpoint.terminate(); channel.port2.close(); }
});

test('message events retain their target and modal replies remain bound to their originating process', () => {
    const sent: any[] = [];
    const root = { onmessage: null, postMessage(m: any) { sent.push(m); }, terminate() {} } as unknown as Worker;
    const endpoint = new SessionWorker(root);
    let modal!: MessageEvent;
    endpoint.onmessage = event => { if (event.data.type === 'show_message_box') modal = event; };
    const channel = new MessageChannel();
    try {
        root.onmessage!.call(root, new MessageEvent('message', { data: { type: 'show_message_box', id: 1 } }));
        expect(modal.target).toBe(endpoint);
        root.onmessage!.call(root, new MessageEvent('message', { data: { type: 'child_session', port: channel.port1 } }));
        endpoint.replyTarget(modal).postMessage({ type: 'message_box_result', id: 1, result: 1 });
        expect(sent.at(-1).type).toBe('message_box_result');
    } finally { endpoint.terminate(); channel.port2.close(); }
});

test('nested animation callbacks share one refresh, support cancellation and survive a callback throw', () => {
    let requested = 0;
    const output: number[] = [], errors: unknown[] = [];
    const clock = new ChildFrameClock(() => { requested++; }, error => errors.push(error));
    clock.request(() => { throw new Error('bad callback'); });
    const cancelled = clock.request(() => output.push(-1));
    clock.cancel(cancelled);
    clock.request(time => { output.push(time); clock.request(next => output.push(next)); });
    expect(requested).toBe(1);
    clock.frame(20);
    expect(output).toEqual([20]);
    expect(errors.length).toBe(1);
    expect(requested).toBe(2);
    clock.frame(40);
    expect(output).toEqual([20, 40]);
});

test('attaching the screen keeps the existing GPU device and resources', () => {
    const saved = (globalThis as any).GPUTextureUsage;
    (globalThis as any).GPUTextureUsage = { RENDER_ATTACHMENT: 1, COPY_DST: 2, COPY_SRC: 4 };
    try {
        const backend = new WebGPUBackend();
        const device = {}, texture = {}, pipeline = {};
        let unconfigured = 0, mirrorDestroyed = 0;
        let config: any;
        const context = { configure(value: any) { config = value; } };
        Object.assign(backend, { device, format: 'bgra8unorm', overlayTexture: texture, overlayPipeline: pipeline,
            context: { unconfigure() { unconfigured++; } }, screenMirror: { destroy() { mirrorDestroyed++; } } });
        backend.attachCanvas({ getContext: () => context } as unknown as OffscreenCanvas);
        expect(config.device).toBe(device);
        expect(backend.getDevice()).toBe(device as GPUDevice);
        expect((backend as any).overlayTexture).toBe(texture);
        expect((backend as any).overlayPipeline).toBe(pipeline);
        expect(backend.getContext()).toBe(context as GPUCanvasContext);
        expect(unconfigured).toBe(1);
        expect(mirrorDestroyed).toBe(1);
    } finally { (globalThis as any).GPUTextureUsage = saved; }
});
