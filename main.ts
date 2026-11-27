// png-squeeze: re-encode 1280x720 RGBA screenshots as the smallest lossless PNG.
// Pure Node stdlib (fs, zlib). No network, no install, deterministic output.
//
// Method, per instance:
//   1. Decode the input PNG (stored RGBA) to raw pixels.
//   2. Analyse the pixels: distinct-colour count, all-grey?, alpha all opaque?
//   3. Build the cheapest colour representation that is still exact:
//        - <=256 distinct colours -> palette (colour type 3) + tRNS when needed
//        - all grey + opaque     -> grey (colour type 0)
//        - all grey + alpha      -> grey+alpha (colour type 4)
//        - opaque                -> RGB (colour type 2)
//        - otherwise             -> RGBA (colour type 6)
//   4. Filter every scanline: each candidate tries all five fixed PNG
//      filters plus a per-row adaptive choice, ranked by a fast level-6
//      deflate; the best two streams are refined at level 9 (also trying
//      the Z_FILTERED strategy) and the smallest wins. Fixed filters often
//      beat adaptive ones: unfiltered rows let deflate's own matches find
//      repeated rows and flat runs that no per-row heuristic can see.
//   5. Deflate the filtered stream at level 9 and keep the smallest candidate.
//
// The program answers a whole set (i001..i008) in one run, writing
// /output/<id>/image.png for each, reading /input/<id>/image.png.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const WIDTH = 1280;
const HEIGHT = 720;

// ---- CRC-32 (PNG polynomial, reflected) ------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

// ---- PNG decoding -----------------------------------------------------------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Decode any 8-bit non-interlaced PNG into RGBA bytes. The competition input
// is colour type 6, but every colour type is handled so a changed input still
// decodes exactly.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported PNG form');
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1
    : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error('unsupported colour type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = raw.subarray(src, src + stride);
    src += stride;
    const outRow = rgba.subarray(y * width * 4, (y + 1) * width * 4);
    const prevRow = y > 0 ? rgba.subarray((y - 1) * width * 4, y * width * 4) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prevRow ? prevRow[x] : 0;
      const c = x >= channels && prevRow ? prevRow[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 255;
      row[x] = v;
    }
    // Expand the decoded row to RGBA.
    for (let px = 0; px < width; px++) {
      const o = px * 4;
      const s = px * channels;
      if (colorType === 6) {
        outRow[o] = row[s]; outRow[o + 1] = row[s + 1];
        outRow[o + 2] = row[s + 2]; outRow[o + 3] = row[s + 3];
      } else if (colorType === 2) {
        outRow[o] = row[s]; outRow[o + 1] = row[s + 1];
        outRow[o + 2] = row[s + 2]; outRow[o + 3] = 255;
      } else if (colorType === 0) {
        outRow[o] = row[s]; outRow[o + 1] = row[s];
        outRow[o + 2] = row[s]; outRow[o + 3] = 255;
      } else if (colorType === 4) {
        outRow[o] = row[s]; outRow[o + 1] = row[s];
        outRow[o + 2] = row[s]; outRow[o + 3] = row[s + 1];
      } else if (colorType === 3) {
        const idx = row[s] * 3;
        outRow[o] = palette[idx]; outRow[o + 1] = palette[idx + 1];
        outRow[o + 2] = palette[idx + 2];
        outRow[o + 3] = trns && row[s] < trns.length ? trns[row[s]] : 255;
      }
    }
  }
  return { width, height, rgba };
}

// ---- Filtering ---------------------------------------------------------------
// Filter every scanline with one fixed filter for the whole image.
function filterFixed(data, width, height, bpp, f) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    const o = y * (stride + 1);
    out[o] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) pred = paeth(a, b, c);
      out[o + 1 + x] = (row[x] - pred) & 255;
    }
  }
  return out;
}

// Filter one row with every filter, keep the filter whose bytes have the
// smallest sum of absolute (signed) values, and write that filtered row out.
function filterAdaptive(data, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let bestFilter = 0;
    let bestScore = Infinity;
    let bestRow = null;
    for (let f = 0; f < 5; f++) {
      const tmp = Buffer.alloc(stride);
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const c = x >= bpp && prev ? prev[x - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) pred = paeth(a, b, c);
        const v = (row[x] - pred) & 255;
        tmp[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        bestRow = tmp;
      }
    }
    const o = y * (stride + 1);
    out[o] = bestFilter;
    bestRow.copy(out, o + 1);
  }
  return out;
}

// ---- PNG encoding ------------------------------------------------------------
// Build a PNG from already-deflated IDAT bytes.
function encodePng(width, height, colorType, idat, palette, trns) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Deflate a filtered stream, also trying the Z_FILTERED strategy, and return
// the smaller of the two streams.
function deflateBest(filtered) {
  const a = zlib.deflateSync(filtered, { level: 9, memLevel: 9 });
  const b = zlib.deflateSync(filtered, {
    level: 9, memLevel: 9, strategy: zlib.constants.Z_FILTERED,
  });
  return a.length <= b.length ? a : b;
}

// ---- Per-instance encoding ---------------------------------------------------
function encodeInstance(rgba, width, height) {
  const pixels = width * height;
  // Analyse the pixels once.
  const seen = new Map();
  let allGrey = true;
  let allOpaque = true;
  let paletteList = null;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const a = rgba[o + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    if (seen.size <= 256) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!seen.has(key)) {
        seen.set(key, seen.size);
        if (seen.size > 256) paletteList = null;
      }
    }
  }
  if (seen.size <= 256) {
    paletteList = new Array(seen.size);
    for (const [key, idx] of seen) {
      paletteList[idx] = [(key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255];
    }
  }

  const candidates = [];
  // Try every filter strategy on this colour representation and keep the
  // smallest real deflate output. A fixed filter often beats a per-row
  // adaptive one: unfiltered rows let deflate's own matches find repeated
  // rows and flat runs, which a per-row heuristic cannot see. Strategies
  // are ranked cheaply at level 6 first; only the best two are refined at
  // level 9, which keeps the whole set far inside the 60-second wall.
  const pushCandidate = (colorType, data, palette, trns) => {
    const bpp = colorType === 0 || colorType === 3 ? 1 : colorType === 4 ? 2
      : colorType === 2 ? 3 : 4;
    const streams = [];
    const consider = (filtered) => {
      const fast = zlib.deflateSync(filtered, { level: 6, memLevel: 9 });
      streams.push({ filtered, fastLen: fast.length });
    };
    for (let f = 0; f < 5; f++) consider(filterFixed(data, width, height, bpp, f));
    consider(filterAdaptive(data, width, height, bpp));
    streams.sort((a, b) => a.fastLen - b.fastLen);
    let best = null;
    for (const s of streams.slice(0, 2)) {
      const png = encodePng(width, height, colorType, deflateBest(s.filtered), palette, trns);
      if (!best || png.length < best.length) best = png;
    }
    candidates.push(best);
  };

  // Palette candidate (flat themes): one index byte per pixel.
  if (paletteList) {
    const idx = Buffer.alloc(pixels);
    for (let i = 0; i < pixels; i++) {
      const o = i * 4;
      const key = ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0;
      idx[i] = seen.get(key);
    }
    const plte = Buffer.alloc(paletteList.length * 3);
    const alphas = [];
    let needTrns = false;
    for (let i = 0; i < paletteList.length; i++) {
      plte[i * 3] = paletteList[i][0];
      plte[i * 3 + 1] = paletteList[i][1];
      plte[i * 3 + 2] = paletteList[i][2];
      alphas.push(paletteList[i][3]);
      if (paletteList[i][3] !== 255) needTrns = true;
    }
    let trns = null;
    if (needTrns) {
      let last = alphas.length;
      while (last > 0 && alphas[last - 1] === 255) last--;
      trns = Buffer.from(alphas.slice(0, last));
    }
    pushCandidate(3, idx, plte, trns);
    // Second palette order: entries sorted by luminance. Reordering the
    // palette is free (PLTE defines the mapping) and sometimes filters
    // better than first-occurrence order, so try it and keep the smaller.
    const lumOrder = paletteList.map((c, i) => i).sort((a, b) => {
      const la = paletteList[a][0] * 3 + paletteList[a][1] * 6 + paletteList[a][2];
      const lb = paletteList[b][0] * 3 + paletteList[b][1] * 6 + paletteList[b][2];
      return la - lb;
    });
    const remap = new Uint8Array(paletteList.length);
    lumOrder.forEach((old, i) => { remap[old] = i; });
    const idx2 = Buffer.from(idx);
    for (let i = 0; i < pixels; i++) idx2[i] = remap[idx[i]];
    const plte2 = Buffer.alloc(paletteList.length * 3);
    const alphas2 = [];
    for (let i = 0; i < paletteList.length; i++) {
      const c = paletteList[lumOrder[i]];
      plte2[i * 3] = c[0];
      plte2[i * 3 + 1] = c[1];
      plte2[i * 3 + 2] = c[2];
      alphas2.push(c[3]);
    }
    let trns2 = null;
    if (needTrns) {
      let last = alphas2.length;
      while (last > 0 && alphas2[last - 1] === 255) last--;
      trns2 = Buffer.from(alphas2.slice(0, last));
    }
    pushCandidate(3, idx2, plte2, trns2);
  }

  // Grey candidates (grey themes).
  if (allGrey) {
    if (allOpaque) {
      const grey = Buffer.alloc(pixels);
      for (let i = 0; i < pixels; i++) grey[i] = rgba[i * 4];
      pushCandidate(0, grey, null, null);
    } else {
      const ga = Buffer.alloc(pixels * 2);
      for (let i = 0; i < pixels; i++) {
        ga[i * 2] = rgba[i * 4];
        ga[i * 2 + 1] = rgba[i * 4 + 3];
      }
      pushCandidate(4, ga, null, null);
    }
  }

  // Full-colour candidates.
  if (allOpaque) {
    const rgb = Buffer.alloc(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = rgba[i * 4];
      rgb[i * 3 + 1] = rgba[i * 4 + 1];
      rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    pushCandidate(2, rgb, null, null);
  } else {
    pushCandidate(6, rgba, null, null);
  }

  // Keep the smallest encoding.
  let best = candidates[0];
  for (const c of candidates) if (c.length < best.length) best = c;
  return best;
}

// ---- Main ----------------------------------------------------------------------
function main() {
  const ids = ['i001', 'i002', 'i003', 'i004', 'i005', 'i006', 'i007', 'i008'];
  for (const id of ids) {
    const input = fs.readFileSync(path.join('/input', id, 'image.png'));
    const { width, height, rgba } = decodePng(input);
    const png = encodeInstance(rgba, width, height);
    const outDir = path.join('/output', id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'image.png'), png);
  }
}

main();
