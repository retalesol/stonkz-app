/**
 * Square image cropper — zoom + pan, fixed 1:1 output.
 * No third-party crop library; canvas-only for the launch stepper.
 */

export interface SquareCropResult {
  blob: Blob;
  /** Object URL for preview; caller must revoke when done. */
  previewUrl: string;
}

export interface SquareCropOptions {
  /** Output edge length in px (default 512). */
  size?: number;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  quality?: number;
}

export class SquareCropper {
  private img: HTMLImageElement | null = null;
  private scale = 1;
  private minScale = 1;
  private maxScale = 8;
  private ox = 0;
  private oy = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly size: number;
  private readonly mimeType: SquareCropOptions['mimeType'];
  private readonly quality: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: SquareCropOptions = {},
  ) {
    this.size = opts.size ?? 512;
    this.mimeType = opts.mimeType ?? 'image/png';
    this.quality = opts.quality ?? 0.92;
    canvas.width = this.size;
    canvas.height = this.size;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.img = null;
  }

  async loadFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      this.img = img;
      // Cover the square: shortest side fills the crop.
      this.minScale = Math.max(this.size / img.naturalWidth, this.size / img.naturalHeight);
      this.scale = this.minScale;
      this.maxScale = this.minScale * 8;
      this.ox = (this.size - img.naturalWidth * this.scale) / 2;
      this.oy = (this.size - img.naturalHeight * this.scale) / 2;
      this.draw();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  setZoom(factor: number): void {
    if (!this.img) return;
    const prev = this.scale;
    this.scale = clamp(factor, this.minScale, this.maxScale);
    // Zoom around canvas centre.
    const cx = this.size / 2;
    const cy = this.size / 2;
    this.ox = cx - ((cx - this.ox) * this.scale) / prev;
    this.oy = cy - ((cy - this.oy) * this.scale) / prev;
    this.clampPan();
    this.draw();
  }

  zoomBy(delta: number): void {
    this.setZoom(this.scale * (1 + delta));
  }

  get zoom(): number {
    if (!this.img) return 1;
    return this.scale / this.minScale;
  }

  async export(): Promise<SquareCropResult> {
    if (!this.img) throw new Error('no image loaded');
    const out = document.createElement('canvas');
    out.width = this.size;
    out.height = this.size;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.img, this.ox, this.oy, this.img.naturalWidth * this.scale, this.img.naturalHeight * this.scale);
    const blob = await new Promise<Blob>((resolve, reject) => {
      out.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('crop export failed'))),
        this.mimeType,
        this.quality,
      );
    });
    return { blob, previewUrl: URL.createObjectURL(blob) };
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.img) return;
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, this.size, this.size);
    ctx.drawImage(this.img, this.ox, this.oy, this.img.naturalWidth * this.scale, this.img.naturalHeight * this.scale);
    // Soft vignette frame
    ctx.strokeStyle = 'rgba(242,174,75,.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, this.size - 2, this.size - 2);
  }

  private clampPan(): void {
    if (!this.img) return;
    const w = this.img.naturalWidth * this.scale;
    const h = this.img.naturalHeight * this.scale;
    // Image must always cover the square.
    this.ox = clamp(this.ox, this.size - w, 0);
    this.oy = clamp(this.oy, this.size - h, 0);
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.dragging || !this.img) return;
    this.ox += e.clientX - this.lastX;
    this.oy += e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.clampPan();
    this.draw();
  };

  private readonly onUp = (): void => {
    this.dragging = false;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomBy(e.deltaY < 0 ? 0.08 : -0.08);
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load image'));
    img.src = url;
  });
}
