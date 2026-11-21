import { deflateSync, crc32 } from 'node:zlib';

// Deterministic synthetic "handwriting" used only for seeded demo history until the doctor app supplies fixtures.
export type Stroke = { width: number; points: [number, number][] };
export type SyntheticPage = { png: Buffer; width: number; height: number; strokes: Stroke[]; zlibRows: Buffer };
export const placeholderInkFormat = 'samford-ink-placeholder/0';
const ink: [number, number, number] = [22, 44, 118];

function random(seedText: string) {
  let seed = 2166136261;
  for (const char of seedText) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0; let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Raster {
  data: Uint8Array;
  constructor(public width: number, public height: number) { this.data = new Uint8Array(width * height * 3).fill(255); }
  pixel(x: number, y: number, color: readonly number[]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 3; this.data[at] = color[0]; this.data[at + 1] = color[1]; this.data[at + 2] = color[2];
  }
  rect(x: number, y: number, w: number, h: number, color: readonly number[]) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.pixel(i, j, color); }
  stamp(cx: number, cy: number, radius: number, color: readonly number[]) {
    const r = Math.max(0.8, radius); const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) this.pixel(x, y, color);
  }
  stroke(stroke: Stroke, color: readonly number[]) {
    for (let i = 1; i < stroke.points.length; i++) {
      const [x0, y0] = stroke.points[i - 1]; const [x1, y1] = stroke.points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
      for (let s = 0; s <= steps; s++) this.stamp(x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps, stroke.width / 2, color);
    }
  }
}
// Simple seven-segment-like glyphs keep the visible synthetic banner readable without a font rasterizer.
const glyphs: Record<string, number[][]> = {
  S: [[1, 0, 0, 0], [0, 0, 0, 1], [0, 1, 1, 1], [1, 1, 1, 2], [1, 2, 0, 2]], Y: [[0, 0, 0.5, 1], [1, 0, 0.5, 1], [0.5, 1, 0.5, 2]],
  N: [[0, 2, 0, 0], [0, 0, 1, 2], [1, 2, 1, 0]], T: [[0, 0, 1, 0], [0.5, 0, 0.5, 2]], H: [[0, 0, 0, 2], [1, 0, 1, 2], [0, 1, 1, 1]],
  E: [[1, 0, 0, 0], [0, 0, 0, 2], [0, 2, 1, 2], [0, 1, 0.8, 1]], I: [[0.5, 0, 0.5, 2], [0.1, 0, 0.9, 0], [0.1, 2, 0.9, 2]],
  C: [[1, 0, 0, 0], [0, 0, 0, 2], [0, 2, 1, 2]], A: [[0, 2, 0.5, 0], [0.5, 0, 1, 2], [0.25, 1, 0.75, 1]], M: [[0, 2, 0, 0], [0, 0, 0.5, 1], [0.5, 1, 1, 0], [1, 0, 1, 2]],
  P: [[0, 2, 0, 0], [0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1]], L: [[0, 0, 0, 2], [0, 2, 1, 2]], O: [[0, 0, 1, 0], [1, 0, 1, 2], [1, 2, 0, 2], [0, 2, 0, 0]],
  F: [[1, 0, 0, 0], [0, 0, 0, 2], [0, 1, 0.8, 1]], R: [[0, 2, 0, 0], [0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0.3, 1, 1, 2]], U: [[0, 0, 0, 2], [0, 2, 1, 2], [1, 2, 1, 0]],
  '-': [[0.1, 1, 0.9, 1]], ' ': []
};
function banner(raster: Raster, text: string, x: number, y: number, scale: number, color: readonly number[]) {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    for (const [a, b, c, d] of glyphs[char] ?? []) raster.stroke({ width: Math.max(2, scale / 5), points: [[cursor + a * scale, y + b * scale], [cursor + c * scale, y + d * scale]] }, color);
    cursor += scale * 1.6;
  }
}
function word(next: () => number, x: number, baseline: number, letters: number): Stroke {
  const points: [number, number][] = []; const step = 16 + next() * 8; const loop = 9 + next() * 7; const height = 14 + next() * 10;
  for (let t = 0; t <= letters * Math.PI * 2; t += 0.22) {
    const tall = Math.sin(t / 2 + next() * 0.2) > 0.86 ? 1.9 : 1;
    points.push([x + step * t / (Math.PI * 2) - loop * Math.sin(t) * 0.55, baseline - height * tall * (1 - Math.cos(t)) / 2 + (next() - 0.5) * 1.6]);
  }
  return { width: 3 + next() * 1.2, points };
}
export function synthesizePage(seed: string, kind: 'summary' | 'prescription' | 'investigations', pageIndex: number, width = 1500, height = 2121): SyntheticPage {
  const next = random(`${seed}:${pageIndex}`); const raster = new Raster(width, height); const strokes: Stroke[] = [];
  for (let y = 300; y < height - 160; y += 78) raster.rect(70, y, width - 140, 2, [205, 222, 245]);
  raster.rect(140, 260, 3, height - 400, [245, 205, 205]);
  raster.rect(0, 0, width, 120, [255, 244, 214]);
  const notice = 'SYNTHETIC SAMPLE - NOT FOR CLINICAL USE';
  banner(raster, notice, 70, 38, Math.min(24, (width - 140) / (notice.length * 1.6)), [150, 82, 0]);
  if (kind === 'prescription' && pageIndex === 0) {
    strokes.push({ width: 6, points: [[180, 230], [180, 150], [235, 150], [250, 170], [235, 192], [180, 192]] }, { width: 6, points: [[200, 192], [262, 245]] }, { width: 6, points: [[232, 212], [280, 252]] }, { width: 6, points: [[282, 210], [228, 254]] });
  } else strokes.push(word(next, 180, 215, 6 + Math.floor(next() * 4)));
  strokes.push(word(next, width - 420, 200, 4), { width: 3, points: [[width - 420, 214], [width - 180, 212]] });
  let line = 0;
  for (let baseline = 370; baseline < height - 380; baseline += 78) {
    line++;
    let x = 175 + next() * 20;
    if (kind !== 'summary' && line % 2 === 1) {
      strokes.push({ width: 4, points: [[x, baseline - 28], [x + 4, baseline]] }, { width: 5, points: [[x + 16, baseline - 2], [x + 18, baseline]] }); x += 50;
    }
    const words = kind === 'summary' ? 4 + Math.floor(next() * 5) : 2 + Math.floor(next() * 3);
    for (let w = 0; w < words && x < width - 260; w++) { const letters = 2 + Math.floor(next() * 6); strokes.push(word(next, x, baseline, letters)); x += letters * 21 + 40 + next() * 30; }
    if (kind !== 'summary' && line > 10) break;
  }
  const sx = width - 540; const sy = height - 230; const signature: [number, number][] = [];
  for (let t = 0; t < 18; t += 0.12) signature.push([sx + t * 20 + 26 * Math.sin(t * 1.7), sy - 30 * Math.sin(t) * Math.exp(-t / 14) + (t > 14 ? (t - 14) * 8 : 0)]);
  strokes.push({ width: 4, points: signature }, { width: 3, points: [[sx - 20, sy + 40], [sx + 380, sy + 36]] });
  for (const stroke of strokes) raster.stroke(stroke, ink);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { rows[y * (width * 3 + 1)] = 0; Buffer.from(raster.data.buffer, y * width * 3, width * 3).copy(rows, y * (width * 3 + 1) + 1); }
  const zlibRows = deflateSync(rows, { level: 6 });
  return { png: encodePng(width, height, zlibRows), width, height, strokes, zlibRows };
}
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng(width: number, height: number, zlibRows: Buffer) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibRows), chunk('IEND', Buffer.alloc(0))]);
}
// The PDF embeds exactly the page pixels: the PNG's zlib scanlines with a PNG predictor.
export function pagesToPdf(pages: SyntheticPage[], title: string): Buffer {
  const parts: Buffer[] = []; const offsets: number[] = []; let size = 0;
  const add = (value: string | Buffer) => { const buffer = typeof value === 'string' ? Buffer.from(value, 'latin1') : value; parts.push(buffer); size += buffer.length; };
  const object = (id: number, body: string | Buffer[]) => { offsets[id] = size; add(`${id} 0 obj\n`); if (typeof body === 'string') add(body); else for (const piece of body) add(piece); add('\nendobj\n'); };
  add('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  const kids = pages.map((_, index) => `${4 + index * 3} 0 R`).join(' ');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  object(3, `<< /Title (${title.replace(/[()\\]/g, '')} - SYNTHETIC SAMPLE) /Producer (Samford mock backend) >>`);
  pages.forEach((page, index) => {
    const id = 4 + index * 3; const pageWidth = 595.28; const pageHeight = Number((pageWidth * page.height / page.width).toFixed(2));
    const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, [Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, 'latin1')]);
    object(id + 2, [Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${page.width} >> /Length ${page.zlibRows.length} >>\nstream\n`, 'latin1'), page.zlibRows, Buffer.from('\nendstream', 'latin1')]);
  });
  const count = 4 + pages.length * 3; const xref = size;
  add(`xref\n0 ${count}\n0000000000 65535 f \n${Array.from({ length: count - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, '0')} 00000 n \n`).join('')}`);
  add(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}
export function placeholderInk(pages: SyntheticPage[]): Buffer {
  return Buffer.from(JSON.stringify({
    format: placeholderInkFormat, synthetic: true, note: 'Placeholder strokes generated by the Samford mock backend. This is not samford-ink/1.',
    pages: pages.map((page, index) => ({ index, widthPx: page.width, heightPx: page.height, color: '#162c76',
      strokes: page.strokes.map(stroke => ({ widthPx: Number(stroke.width.toFixed(1)), points: stroke.points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) })) }))
  }));
}
const cache = new Map<string, { pages: SyntheticPage[]; pdf: Buffer; ink: Buffer }>();
export function syntheticDocument(seed: string, kind: 'summary' | 'prescription' | 'investigations', pageCount: number, title: string) {
  const key = `${seed}:${kind}:${pageCount}:${title}`;
  let value = cache.get(key);
  if (!value) {
    const pages = Array.from({ length: pageCount }, (_, index) => synthesizePage(seed, kind, index));
    value = { pages, pdf: pagesToPdf(pages, title), ink: placeholderInk(pages) };
    cache.set(key, value);
  }
  return value;
}
