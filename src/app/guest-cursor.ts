/**
 * The guest's pointer, drawn by the host.
 *
 * Pointer Lock is a HOST transport decision and must not be observable by the guest —
 * yet it hides the OS pointer, so a CSS `cursor:` shape stops existing the moment we
 * lock. There is therefore exactly ONE renderer: the canvas carries `cursor: none`
 * unconditionally and we blit the guest's shape at the virtual cursor. Nothing in the
 * drawing path branches on lock state, so the invariant holds by construction.
 *
 * Inputs, each either pushed in or read every frame:
 *   shape         push — setShape(), from the worker's cursor_image
 *   visible       push — setVisible(), from cursor_visibility
 *   pointerInside push — setPointerInside(), from canvas hover / pointer lock
 *   geometry      pull — getGeometry(); the host caches those rects and re-measures on
 *                        resize / fullscreen / visualViewport / guest resolution change,
 *                        so no frame here performs a layout read
 *   position      pull — getPosition(), the SAB word the guest itself reads. The worker
 *                        writes it directly (SetCursorPos, warp bursts) with no host-side
 *                        event to subscribe to, which is why the loop polls at all.
 */

/** Canvas geometry and the guest screen it maps onto, all in client coordinates. */
export interface CursorGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Containing block of the cursor element — transforms are relative to it. */
  originLeft: number;
  originTop: number;
  /** Screen the SAB position and the cursor bitmap are both expressed in. */
  spaceWidth: number;
  spaceHeight: number;
}

/** Harness-visible: "is the pointer the user sees where the guest thinks it is". */
export interface GuestCursorStatus {
  drawn: boolean;
  /** Guest-space position the pointer was last drawn at. */
  x: number;
  y: number;
  /** On-screen size in CSS pixels. */
  width: number;
  height: number;
  /** Guest pixels → CSS pixels. */
  scale: number;
  shape: "guest" | "fallback" | null;
  /** cursor_image messages seen — 0 with shape "fallback" means the worker sent none. */
  updates: number;
}

interface Shape {
  source: "guest" | "fallback";
  image: HTMLCanvasElement;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

/**
 * IDC_ARROW. The worker resolves the default cursor to a real rasterized user object,
 * so this should never be reached — but a single renderer with a null-shape hole would
 * draw NOTHING where the CSS one silently fell back to the UA arrow, which is strictly
 * worse than what it replaces.
 *
 * 'X' = black outline, '.' = white fill, ' ' = transparent — the SAME convention and
 * the same glyph as user32/system-cursors.ts. It has to be: the two swap in and out
 * depending on whether a shape reached us, and an inverted copy here turned the pointer
 * into a black arrow with a white outline whenever it did not.
 */
const FALLBACK_ARROW = [
  "X           ",
  "XX          ",
  "X.X         ",
  "X..X        ",
  "X...X       ",
  "X....X      ",
  "X.....X     ",
  "X......X    ",
  "X.......X   ",
  "X........X  ",
  "X.....XXXXX ",
  "X..X..X     ",
  "X.X X..X    ",
  "XX  X..X    ",
  "X    X..X   ",
  "     X..X   ",
  "      X..X  ",
  "      X..X  ",
  "       XX   ",
];

function shapeFromPixels(
  pixels: ArrayBuffer,
  width: number,
  height: number,
  hotspotX: number,
  hotspotY: number,
): Shape | null {
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const ctx = image.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels, 0, width * height * 4), width, height), 0, 0);
  return {
    source: "guest",
    image,
    width,
    height,
    hotspotX: Math.min(Math.max(hotspotX, 0), width - 1),
    hotspotY: Math.min(Math.max(hotspotY, 0), height - 1),
  };
}

function buildFallbackArrow(): Shape | null {
  const width = FALLBACK_ARROW[0]!.length;
  const height = FALLBACK_ARROW.length;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = FALLBACK_ARROW[y]!;
    for (let x = 0; x < width; x++) {
      const c = row[x];
      if (c !== "X" && c !== ".") continue;
      const i = (y * width + x) * 4;
      const v = c === "." ? 255 : 0;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  const shape = shapeFromPixels(rgba.buffer, width, height, 0, 0);
  if (shape) shape.source = "fallback";
  return shape;
}

export class GuestCursorRenderer {
  private el: HTMLCanvasElement | null = null;
  private guestShape: Shape | null = null;
  private fallbackShape: Shape | null = null;
  private visible = true;
  private inside = false;
  private raf = 0;
  /** What the backing store currently holds, so a still frame re-rasterizes nothing. */
  private drawn: { shape: Shape; width: number; height: number; dpr: number } | null = null;

  readonly status: GuestCursorStatus = {
    drawn: false, x: 0, y: 0, width: 0, height: 0, scale: 1, shape: null, updates: 0,
  };

  constructor(
    private readonly src: {
      getPosition(): { x: number; y: number } | null;
      getGeometry(): CursorGeometry | null;
    },
  ) {}

  attach(el: HTMLCanvasElement | null): void {
    this.el = el;
    this.refresh();
  }

  /** null pixels = the guest asked for a system shape; fall back rather than vanish. */
  setShape(
    pixels: ArrayBuffer | null,
    width: number,
    height: number,
    hotspotX: number,
    hotspotY: number,
  ): void {
    let next: Shape | null = null;
    if (pixels && width > 0 && height > 0 && pixels.byteLength >= width * height * 4) {
      try {
        next = shapeFromPixels(pixels, width, height, hotspotX, hotspotY);
      } catch {
        next = null;
      }
    }
    this.guestShape = next;
    this.status.updates++;
    this.refresh();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.refresh();
  }

  setPointerInside(inside: boolean): void {
    if (this.inside === inside) return;
    this.inside = inside;
    this.refresh();
  }

  /** Re-place the pointer now — for geometry changes, which the loop cannot observe. */
  sync(): void {
    this.draw();
  }

  dispose(): void {
    this.stop();
    this.hide();
    this.el = null;
  }

  private refresh(): void {
    if (this.visible && this.inside && this.el) this.start();
    else this.stop();
    this.draw();
  }

  private start(): void {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.draw();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private hide(): void {
    this.status.drawn = false;
    const el = this.el;
    if (el && el.style.display !== "none") el.style.display = "none";
  }

  private shape(): Shape | null {
    if (this.guestShape) return this.guestShape;
    this.fallbackShape ??= buildFallbackArrow();
    return this.fallbackShape;
  }

  private draw(): void {
    const el = this.el;
    if (!el || !this.visible || !this.inside) {
      this.hide();
      return;
    }
    const shape = this.shape();
    const geo = this.src.getGeometry();
    const pos = this.src.getPosition();
    if (!shape || !geo || !pos) {
      this.hide();
      return;
    }

    // One scale for both: the bitmap and the SAB position are authored in the same guest
    // screen. Scaling the shape WITH the canvas is the faithful choice — the guest's
    // screen is our canvas, and a 32px cursor covered 32 of its pixels.
    const scaleX = geo.width / Math.max(1, geo.spaceWidth);
    const scaleY = geo.height / Math.max(1, geo.spaceHeight);
    const width = Math.max(1, Math.round(shape.width * scaleX));
    const height = Math.max(1, Math.round(shape.height * scaleY));
    const dpr = window.devicePixelRatio || 1;
    this.rasterize(el, shape, width, height, dpr);

    const x = geo.left - geo.originLeft + (pos.x - shape.hotspotX) * scaleX;
    const y = geo.top - geo.originTop + (pos.y - shape.hotspotY) * scaleY;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (el.style.display !== "block") el.style.display = "block";

    const status = this.status;
    status.drawn = true;
    status.x = pos.x;
    status.y = pos.y;
    status.width = width;
    status.height = height;
    status.scale = scaleX;
    status.shape = shape.source;
  }

  /** Rasterize at device resolution with nearest-neighbour — these are pixel-art shapes. */
  private rasterize(
    el: HTMLCanvasElement,
    shape: Shape,
    width: number,
    height: number,
    dpr: number,
  ): void {
    const drawn = this.drawn;
    if (drawn && drawn.shape === shape && drawn.width === width && drawn.height === height && drawn.dpr === dpr) {
      return;
    }
    const backingW = Math.max(1, Math.round(width * dpr));
    const backingH = Math.max(1, Math.round(height * dpr));
    el.width = backingW;
    el.height = backingH;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, backingW, backingH);
    ctx.drawImage(shape.image, 0, 0, shape.width, shape.height, 0, 0, backingW, backingH);
    this.drawn = { shape, width, height, dpr };
  }
}
