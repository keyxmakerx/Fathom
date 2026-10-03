// "This view": the live canvas as a PNG, drawn by the browser itself (no
// library, no network). Only the drawing pane is copied — never the config
// drawer, panels or editor chrome — and always in the light theme, on paper white.

/** Left out of the copy: selection frames and every handle (edit affordances). */
const OMIT = '.react-flow__handle, .react-flow__nodesselection, .react-flow__selection, .react-flow__resize-control, .react-flow__edgeupdater, [data-print-omit]';
const MAX_SIDE_PX = 8000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The view could not be drawn as a picture.'));
    img.src = src;
  });
}

/** The pane's pixels as a `data:image/png` URL, or `null` when there is no drawing on screen. */
export async function captureViewPng(blackAndWhite: boolean): Promise<string | null> {
  const pane = document.querySelector<HTMLElement>('.drawing .react-flow__renderer');
  if (pane == null) return null;
  const rect = pane.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;

  const root = document.documentElement;
  const previousTheme = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'light');
  let markup: string;
  try {
    const clone = pane.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(OMIT).forEach((el) => el.remove());
    // Strip the omitted nodes from the clone first, then copy styles against the live tree by index.
    inlineStylesLive(pane, clone);
    clone.style.background = '#fff';
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    if (blackAndWhite) clone.style.filter = 'grayscale(1)';
    markup = new XMLSerializer().serializeToString(clone);
  } finally {
    if (previousTheme == null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previousTheme);
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">` +
    `<foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const scale = Math.min(2, MAX_SIDE_PX / rect.width, MAX_SIDE_PX / rect.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx == null) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return cropToContent(canvas).toDataURL('image/png');
}

/** Trims the empty paper around the drawing, keeping a small margin. */
function cropToContent(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (ctx == null) return canvas;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas;
  const pad = 32;
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const out = document.createElement('canvas');
  out.width = Math.min(width, maxX + pad) - x0;
  out.height = Math.min(height, maxY + pad) - y0;
  out.getContext('2d')?.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** `inlineStyles`, matching a clone that had nodes removed: pair children by
 * walking both trees and skipping live nodes the omit selector would remove. */
function inlineStylesLive(source: Element, clone: Element): void {
  const computed = getComputedStyle(source);
  const style = (clone as HTMLElement).style;
  for (let i = 0; i < computed.length; i += 1) {
    const name = computed[i];
    style.setProperty(name, computed.getPropertyValue(name));
  }
  const live = [...source.children].filter((el) => !el.matches(OMIT));
  const copy = [...clone.children];
  for (let i = 0; i < live.length && i < copy.length; i += 1) inlineStylesLive(live[i], copy[i]);
}

/** Saves a data URL as a file — a click on a throwaway link, nothing uploaded. */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
