/** A new transferable output surface over the stable canvas used for input and layout. */
export class ChildSessionSurface {
    private surface: HTMLCanvasElement | null = null;
    private resize: ResizeObserver;
    private mutations: MutationObserver;
    private anchorSize: { width: string; height: string } | null = null;
    constructor(private anchor: HTMLCanvasElement, private layoutChanged: () => void = () => {}) {
        this.resize = new ResizeObserver(() => this.sync());
        this.resize.observe(anchor);
        if (anchor.parentElement) this.resize.observe(anchor.parentElement);
        this.mutations = new MutationObserver(() => this.sync());
        this.mutations.observe(anchor, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    create(width: number, height: number): OffscreenCanvas {
        this.clear();
        const surface = document.createElement('canvas');
        surface.dataset.childSession = 'true';
        surface.setAttribute('aria-hidden', 'true');
        surface.width = width; surface.height = height;
        Object.assign(surface.style, { position: 'absolute', pointerEvents: 'none', zIndex: '2' });
        this.anchor.after(surface);
        this.surface = surface;
        this.anchorSize = { width: this.anchor.style.width, height: this.anchor.style.height };
        this.fit(width / window.devicePixelRatio, height / window.devicePixelRatio);
        this.sync();
        return surface.transferControlToOffscreen();
    }
    fit(width: number, height: number): void {
        if (!this.surface) return;
        // An exited launcher may never have committed a frame, so its transferred
        // canvas placeholder can still report 300x150. Layout cannot depend on it.
        this.anchor.style.width = `${width}px`;
        this.anchor.style.height = `${height}px`;
        this.sync();
    }
    private sync(): void {
        if (!this.surface || !this.anchor.parentElement) return;
        const rect = this.anchor.getBoundingClientRect();
        const parent = this.anchor.parentElement.getBoundingClientRect();
        Object.assign(this.surface.style, {
            left: `${rect.left - parent.left - this.anchor.parentElement.clientLeft}px`,
            top: `${rect.top - parent.top - this.anchor.parentElement.clientTop}px`,
            width: `${rect.width}px`, height: `${rect.height}px`,
            imageRendering: getComputedStyle(this.anchor).imageRendering,
        });
        this.layoutChanged();
    }
    clear(): void {
        this.surface?.remove(); this.surface = null;
        if (this.anchorSize) Object.assign(this.anchor.style, this.anchorSize);
        this.anchorSize = null;
    }
    dispose(): void { this.clear(); this.resize.disconnect(); this.mutations.disconnect(); }
}
