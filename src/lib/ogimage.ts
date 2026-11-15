// Deterministic text title card (brand + title) for net-new posts (spec 6.5/6.6).
//
// Trade-off: SVG would look nicer, but Synta renders the hero through next/image (SVG blocked
// without dangerouslyAllowSVG) and social crawlers ignore SVG OG images. Converting SVG→PNG needs a
// native or wasm rasterizer plus a font file. So this draws a PNG directly with a built-in 5x7 bitmap
// font and node:zlib: zero dependencies, byte-identical output for the same input, blocky retro look.

import { deflateSync } from "node:zlib";
import type { SanityPort } from "./sanity.js";

// 5x7 glyphs, one 5-bit row per entry (MSB = leftmost pixel). Lowercase is drawn as uppercase.
const G: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8],
  ":": [0, 12, 12, 0, 12, 12, 0], ";": [0, 12, 12, 0, 12, 4, 8], "!": [4, 4, 4, 4, 4, 0, 4],
  "?": [14, 17, 1, 2, 4, 0, 4], "'": [4, 4, 8, 0, 0, 0, 0], '"': [10, 10, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 31, 0, 0, 0], "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8],
  "/": [0, 1, 2, 4, 8, 16, 0], "&": [12, 18, 20, 8, 21, 18, 13], "+": [0, 4, 4, 31, 4, 4, 0],
  "%": [24, 25, 2, 4, 8, 19, 3], $: [4, 15, 20, 14, 5, 30, 4], "#": [10, 10, 31, 10, 31, 10, 10],
  _: [0, 0, 0, 0, 0, 0, 31], "=": [0, 0, 31, 0, 31, 0, 0], "|": [4, 4, 4, 4, 4, 4, 4],
};

export type Rgb = [number, number, number];
export type TitleCardInput = {
  brand: string;
  title: string;
  width?: number;
  height?: number;
  colors?: { bg?: Rgb; fg?: Rgb; accent?: Rgb };
};

const DEFAULT_COLORS = { bg: [28, 25, 23] as Rgb, fg: [250, 245, 235] as Rgb, accent: [193, 95, 60] as Rgb };

export function cardText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .toUpperCase()
    .split("")
    .map((c) => (G[c] ? c : "?"))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(" ")) {
    while (word.length > maxChars) {
      if (cur) lines.push(cur), (cur = "");
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= maxChars) cur += ` ${word}`;
    else lines.push(cur), (cur = word);
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Render the title card as a PNG buffer. Same input → same bytes. */
export function renderTitleCardPng(input: TitleCardInput): Buffer {
  const W = input.width ?? 1200;
  const H = input.height ?? 630;
  const c = { ...DEFAULT_COLORS, ...input.colors };
  const px = Buffer.alloc(W * H * 3);
  const rect = (x: number, y: number, w: number, h: number, rgb: Rgb) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) px.set(rgb, (yy * W + xx) * 3);
  };
  const text = (s: string, x: number, y: number, scale: number, rgb: Rgb) => {
    [...s].forEach((ch, i) => {
      const rows = G[ch] ?? G["?"];
      rows.forEach((bits, r) => {
        for (let col = 0; col < 5; col++) if (bits & (16 >> col)) rect(x + (i * 6 + col) * scale, y + r * scale, scale, scale, rgb);
      });
    });
  };

  rect(0, 0, W, H, c.bg);
  const margin = Math.round(W * 0.07);
  rect(margin, margin, Math.round(W * 0.08), Math.max(4, Math.round(H * 0.012)), c.accent);
  const brandScale = Math.max(2, Math.round(H / 126));
  text(cardText(input.brand), margin, margin + Math.round(H * 0.05), brandScale, c.accent);

  // Largest scale whose wrapped title fits the box below the brand line.
  const top = margin + Math.round(H * 0.05) + brandScale * 7 + Math.round(H * 0.08);
  const boxW = W - 2 * margin;
  const boxH = H - top - margin;
  const title = cardText(input.title);
  let scale = 10;
  let lines: string[] = [];
  for (; scale >= 3; scale--) {
    lines = wrap(title, Math.floor((boxW + scale) / (6 * scale)));
    if (lines.length * 10 * scale - 3 * scale <= boxH) break;
  }
  const maxLines = Math.max(1, Math.floor((boxH + 3 * scale) / (10 * scale)));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, "...");
  }
  lines.forEach((l, i) => text(l, margin, top + i * 10 * scale, scale, c.fg));
  return encodePng(W, H, px);
}

// ---------- minimal PNG encoder (8-bit RGB, filter 0) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(w: number, h: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Render and upload the hero image. Throws on failure; the caller holds the publish (6.6). */
export async function makeHeroImage(
  sanity: Pick<SanityPort, "uploadImage">,
  input: TitleCardInput & { slug: string },
  render: (i: TitleCardInput) => Buffer = renderTitleCardPng,
): Promise<{ assetId: string; url: string; alt: string }> {
  const png = render(input);
  if (png.length < 100 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("hero image render produced an invalid PNG");
  const { assetId, url } = await sanity.uploadImage(png, `${input.slug}-og.png`, "image/png");
  return { assetId, url, alt: input.title };
}
