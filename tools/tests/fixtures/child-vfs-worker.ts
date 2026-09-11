import { createChildVfsClient } from '../../../src/worker/core/child-vfs';

self.onmessage = async (event: MessageEvent) => {
    try {
        const vfs = createChildVfsClient(event.data.buffer,
            request => self.postMessage({ type: 'io', request }), 'C:\\');
        const opened = vfs.open('helper.exe', 0x80000000, 3);
        const isPromise = opened instanceof Promise;
        const file = (await opened)!;
        const bytes = vfs.readSync(file, 140_000)!;
        const duplicate = vfs.duplicateHandle(file, 42);
        const target = new Uint8Array(12);
        target.fill(0xee);
        const read = await vfs.readInto(duplicate, target, 2, 8);
        self.postMessage({ type: 'done', isPromise, size: bytes.length,
            mismatch: bytes.findIndex((byte, index) => byte !== (index & 255)),
            position: file.position, duplicatePosition: duplicate.position,
            read, target: Array.from(target), cwd: vfs.currentDir });
    } catch (error) {
        self.postMessage({ type: 'failed', error: String(error) });
    }
};
