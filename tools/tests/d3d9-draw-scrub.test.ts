import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { onFrameEnd } from "../../src/worker/modules/ddraw/frame-capture";

test("excluding a target-local draw interval preserves other targets and later compositing", () => {
    const d: any = Object.create(D3D9Device.prototype);
    let target = 123;
    Object.assign(d, { scrubFrameSerial: -1, scrubDrawIndex: 0, scrubLastFrameDraws: 0, captureRtId: () => target });
    d.setDrawScrub(1, 2, 123, true);
    expect(d.scrubbedOut()).toBe(false);
    target = 456;
    expect(d.scrubbedOut()).toBe(false);
    target = 123;
    expect(d.scrubbedOut()).toBe(true);
    expect(d.scrubbedOut()).toBe(true);
    expect(d.scrubbedOut()).toBe(false);
    onFrameEnd("d3d9");
    expect(d.scrubbedOut()).toBe(false);
    expect(d.getDrawScrub().lastFrameDraws).toBe(4);
    d.setDrawScrub(1, 2, 123);
    onFrameEnd("d3d9");
    expect([d.scrubbedOut(), d.scrubbedOut(), d.scrubbedOut(), d.scrubbedOut()]).toEqual([true, false, false, true]);
});
