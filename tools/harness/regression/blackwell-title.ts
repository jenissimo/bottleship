/** Look for the orange logo and four separate menu rows in a 640 × 480 game frame. */
export function scoreBlackwellTitle(pixels: Uint8ClampedArray) {
    function orangeShare(x: number, y: number, width: number, height: number): number {
        let hits = 0;
        for (let row = y; row < y + height; row++) {
            for (let column = x; column < x + width; column++) {
                const at = (row * 640 + column) * 4;
                const red = pixels[at], green = pixels[at + 1], blue = pixels[at + 2];
                if (red >= 90 && red >= green + 20 && green >= blue + 7 && red >= blue + 35) hits++;
            }
        }
        return hits / (width * height);
    }

    const logo = orangeShare(34, 62, 430, 103);
    const items = [212, 246, 282, 314].map(y => orangeShare(37, y, 149, 18));
    const gaps = [232, 266].map(y => orangeShare(37, y, 149, 6));
    // The title art fades in before the menu. Dark gaps also distinguish
    // the four labels from a solid orange patch in the same area.
    const matches = logo >= 0.12 && logo <= 0.42 &&
        items.every(share => share >= 0.09) && gaps.every(share => share <= 0.08);
    return { matches, logo, items, gaps };
}

export const readBlackwellTitle = `(async () => {
    const bs = window.__BS__;
    const shot = await bs.harness.rpc("shot", [], { timeoutMs: 4000 });
    const png = Uint8Array.from(atob(shot.base64), char => char.charCodeAt(0));
    const image = await createImageBitmap(new Blob([png], { type: "image/png" }));
    try {
        const published = bs.presentRect;
        const rect = published?.outW === image.width && published?.outH === image.height
            ? published : { x: 0, y: 0, w: image.width, h: image.height };
        const ctx = new OffscreenCanvas(640, 480).getContext("2d");
        ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, 640, 480);
        return (${scoreBlackwellTitle.toString()})(ctx.getImageData(0, 0, 640, 480).data);
    } finally {
        image.close();
    }
})()`;
