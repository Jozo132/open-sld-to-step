/**
 * Extract PNG thumbnail/preview images from SolidWorks .SLDPRT files.
 *
 * Supports SolidWorks 2015+ "3D Storage" format (the default since SW 2015)
 * as well as legacy OLE2/CFB files (pre-2015).
 *
 * Pure vanilla Node.js – no external dependencies, no SolidWorks installation
 * required. Works by parsing the internal section table and decompressing
 * deflate-compressed PNG streams embedded in the proprietary storage format.
 *
 * Usage:
 *   node tests/extract-sldprt-thumbnail.js [input.SLDPRT | folder]
 *
 * Defaults to the NIST SolidWorks MBD 2018 sample folder when no argument given.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync, deflateSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Magic signatures ─────────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const OLE2_SIG = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

/**
 * Section marker that precedes every data section in SolidWorks 3D Storage v4.
 * Structure after the marker:
 *   [6 bytes marker] [4 bytes typeId] [4 bytes field1] [4 bytes compressedSize]
 *   [4 bytes decompressedSize] [4 bytes nameLength]
 *   [nameLength bytes name/metadata (XOR-encoded)]
 *   [compressedSize bytes deflate-compressed payload]
 *
 * PNG sections come in two flavours:
 *   - nameLength=33, typeId=3762d8df → configuration-specific views (one per config)
 *   - nameLength=10, typeId varies  → the main part thumbnail / preview
 * We prefer the main thumbnail (nameLen=10) when available.
 */
const SECTION_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SECTION_HEADER_SIZE = 26; // 6 + 4 + 4 + 4 + 4 + 4
const THUMBNAIL_NAME_LEN = 10; // main preview section always has nameLen=10

// ── SW 3D Storage extraction (SW 2015+) ─────────────────────────────

/**
 * Parse all sections from a SolidWorks 3D Storage v4 file and extract
 * any that decompress to a valid PNG image.
 *
 * Returns an array of { data: Buffer, offset: number, isThumbnail: boolean }
 * sorted so the main thumbnail (nameLen=10) comes first, then by size descending.
 */
function extractFromSW3DStorage(buf) {
    const results = [];
    let idx = 0;

    while ((idx = buf.indexOf(SECTION_MARKER, idx)) >= 0) {
        if (idx + SECTION_HEADER_SIZE > buf.length) break;

        const compressedSize = buf.readUInt32LE(idx + 14);
        const decompressedSize = buf.readUInt32LE(idx + 18);
        const nameLength = buf.readUInt32LE(idx + 22);

        // Sanity checks to skip garbage matches
        if (
            nameLength > 0 && nameLength < 1024 &&
            compressedSize > 64 && compressedSize < buf.length &&
            decompressedSize > 64 && decompressedSize < 50_000_000
        ) {
            const dataOffset = idx + SECTION_HEADER_SIZE + nameLength;
            const dataEnd = dataOffset + compressedSize;

            if (dataEnd <= buf.length) {
                try {
                    const decompressed = inflateRawSync(
                        buf.subarray(dataOffset, dataEnd),
                        { maxOutputLength: decompressedSize + 1024 }
                    );

                    if (decompressed.length >= 8 && decompressed.subarray(0, 8).equals(PNG_SIG)) {
                        const isThumbnail = nameLength === THUMBNAIL_NAME_LEN;
                        results.push({ data: decompressed, offset: idx, isThumbnail });
                    }
                } catch {
                    // Not a valid deflate stream at this offset – skip
                }
            }
        }

        idx++;
    }

    // Prefer the main thumbnail; within each group, sort by size descending
    results.sort((a, b) => {
        if (a.isThumbnail !== b.isThumbnail) return a.isThumbnail ? -1 : 1;
        return b.data.length - a.data.length;
    });
    return results;
}

// ── OLE2/CFB extraction (pre-2015 legacy) ───────────────────────────

/**
 * Minimal OLE2/CFB parser – just enough to enumerate streams and find
 * embedded PNG images.  No external dependency needed.
 */
function extractFromOLE2(buf) {
    const sectorSize = 1 << buf.readUInt16LE(30);
    const dirStartSector = buf.readUInt32LE(48);
    const difatStartSector = buf.readInt32LE(68);

    // Build FAT (File Allocation Table)
    const difat = [];

    // First 109 DIFAT entries live in the header
    for (let i = 0; i < 109; i++) {
        const sector = buf.readInt32LE(76 + i * 4);
        if (sector >= 0) difat.push(sector);
    }

    // Follow DIFAT chain for additional entries
    let difatSec = difatStartSector;
    while (difatSec >= 0 && difatSec < 0xFFFFFFFE) {
        const off = (difatSec + 1) * sectorSize;
        for (let i = 0; i < (sectorSize / 4) - 1; i++) {
            const sector = buf.readInt32LE(off + i * 4);
            if (sector >= 0) difat.push(sector);
        }
        difatSec = buf.readInt32LE(off + sectorSize - 4);
    }

    // Read FAT sectors
    const fat = [];
    for (const sec of difat) {
        const off = (sec + 1) * sectorSize;
        for (let i = 0; i < sectorSize / 4; i++) {
            fat.push(buf.readInt32LE(off + i * 4));
        }
    }

    /** Read a chain of sectors into a single buffer. */
    function readChain(startSector) {
        const chunks = [];
        let sec = startSector;
        const visited = new Set();
        while (sec >= 0 && sec < 0xFFFFFFFE) {
            if (visited.has(sec)) break;
            visited.add(sec);
            const off = (sec + 1) * sectorSize;
            if (off + sectorSize > buf.length) break;
            chunks.push(buf.subarray(off, off + sectorSize));
            sec = fat[sec] ?? -1;
        }
        return Buffer.concat(chunks);
    }

    // Read directory entries
    const dirData = readChain(dirStartSector);
    const entries = [];
    for (let i = 0; i < dirData.length; i += 128) {
        const nameLen = dirData.readUInt16LE(i + 64);
        if (nameLen === 0) continue;
        const name = dirData.subarray(i, i + nameLen - 2).toString('utf16le');
        const type = dirData[i + 66];
        const startSector = dirData.readInt32LE(i + 116);
        const size = dirData.readUInt32LE(i + 120);
        entries.push({ name, type, startSector, size });
    }

    const results = [];

    // Look for PreviewPNG stream first
    for (const entry of entries) {
        if (entry.name === 'PreviewPNG' && entry.startSector >= 0) {
            const streamData = readChain(entry.startSector).subarray(0, entry.size);
            if (streamData.length >= 8 && streamData.subarray(0, 8).equals(PNG_SIG)) {
                results.push({ data: streamData, offset: 0, streamName: entry.name });
            }
        }
    }

    // Scan all streams for embedded PNGs
    if (results.length === 0) {
        for (const entry of entries) {
            if (entry.type !== 2 || entry.startSector < 0 || entry.size < 16) continue;
            const streamData = readChain(entry.startSector).subarray(0, entry.size);
            const pngOff = streamData.indexOf(PNG_SIG);
            if (pngOff >= 0) {
                const iend = streamData.indexOf(Buffer.from('IEND'), pngOff);
                const end = iend > pngOff ? iend + 8 : streamData.length;
                results.push({
                    data: streamData.subarray(pngOff, end),
                    offset: pngOff,
                    streamName: entry.name,
                });
            }
        }
    }

    results.sort((a, b) => b.data.length - a.data.length);
    return results;
}

// ── Raw binary scan fallback ─────────────────────────────────────────

/** Last-resort scan for raw (uncompressed) PNG in the binary. */
function scanForRawPNG(buf) {
    const pngOff = buf.indexOf(PNG_SIG);
    if (pngOff < 0) return null;

    const iend = buf.indexOf(Buffer.from('IEND'), pngOff);
    const end = iend > pngOff ? iend + 8 : buf.length;
    return buf.subarray(pngOff, end);
}

// ── PNG image processing (decode, crop, transparency, encode) ────────

/** Compute CRC32 for PNG chunks. */
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Decode a PNG buffer into raw RGBA pixel data.
 * Returns { width, height, pixels: Buffer } where pixels is RGBA, 4 bytes/pixel.
 */
function decodePNG(png) {
    if (!png.subarray(0, 8).equals(PNG_SIG)) throw new Error('Not a PNG');

    let width, height, bitDepth, colorType;
    const idatChunks = [];
    let off = 8;

    while (off < png.length) {
        const len = png.readUInt32BE(off);
        const type = png.toString('ascii', off + 4, off + 8);
        const chunkData = png.subarray(off + 8, off + 8 + len);

        if (type === 'IHDR') {
            width = chunkData.readUInt32BE(0);
            height = chunkData.readUInt32BE(4);
            bitDepth = chunkData[8];
            colorType = chunkData[9];
        } else if (type === 'IDAT') {
            idatChunks.push(chunkData);
        } else if (type === 'IEND') {
            break;
        }
        off += 12 + len; // 4 len + 4 type + data + 4 crc
    }

    if (!width || !height) throw new Error('Missing IHDR');

    const compressed = Buffer.concat(idatChunks);
    const raw = inflateSync(compressed);

    // Determine bytes per pixel based on colorType
    let bpp;
    switch (colorType) {
        case 0: bpp = 1; break;           // Grayscale
        case 2: bpp = 3; break;           // RGB
        case 4: bpp = 2; break;           // Grayscale+Alpha
        case 6: bpp = 4; break;           // RGBA
        default: throw new Error(`Unsupported colorType ${colorType}`);
    }

    const stride = width * bpp;
    const pixels = Buffer.alloc(width * height * 4); // Output is always RGBA

    // Un-filter scanlines
    const prev = Buffer.alloc(stride); // previous row (starts as zeros)
    for (let y = 0; y < height; y++) {
        const rowOff = y * (stride + 1); // +1 for filter byte
        const filterType = raw[rowOff];
        const row = raw.subarray(rowOff + 1, rowOff + 1 + stride);

        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? row[x - bpp] : 0;         // left
            const b = prev[x];                              // above
            const c = x >= bpp ? prev[x - bpp] : 0;        // upper-left

            switch (filterType) {
                case 0: break;                                        // None
                case 1: row[x] = (row[x] + a) & 0xFF; break;       // Sub
                case 2: row[x] = (row[x] + b) & 0xFF; break;       // Up
                case 3: row[x] = (row[x] + ((a + b) >>> 1)) & 0xFF; break; // Average
                case 4: {                                             // Paeth
                    const p = a + b - c;
                    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                    row[x] = (row[x] + pr) & 0xFF;
                    break;
                }
            }
        }

        // Convert to RGBA output
        for (let x = 0; x < width; x++) {
            const dstOff = (y * width + x) * 4;
            switch (colorType) {
                case 0: // Grayscale
                    pixels[dstOff] = pixels[dstOff + 1] = pixels[dstOff + 2] = row[x];
                    pixels[dstOff + 3] = 255;
                    break;
                case 2: // RGB
                    pixels[dstOff] = row[x * 3];
                    pixels[dstOff + 1] = row[x * 3 + 1];
                    pixels[dstOff + 2] = row[x * 3 + 2];
                    pixels[dstOff + 3] = 255;
                    break;
                case 4: // Grayscale+Alpha
                    pixels[dstOff] = pixels[dstOff + 1] = pixels[dstOff + 2] = row[x * 2];
                    pixels[dstOff + 3] = row[x * 2 + 1];
                    break;
                case 6: // RGBA
                    pixels[dstOff] = row[x * 4];
                    pixels[dstOff + 1] = row[x * 4 + 1];
                    pixels[dstOff + 2] = row[x * 4 + 2];
                    pixels[dstOff + 3] = row[x * 4 + 3];
                    break;
            }
        }

        prev.set(row);
    }

    return { width, height, pixels };
}

/**
 * Find bounding box of non-background pixels and crop.
 * Detects background color from the top-left corner pixel.
 * Returns { width, height, pixels } for the cropped image, with padding.
 */
function autoCrop(pixels, width, height, padding = 4, tolerance = 10) {
    // Sample top-left pixel as background color
    const bg = [pixels[0], pixels[1], pixels[2]];

    function isBg(off) {
        return Math.abs(pixels[off] - bg[0]) <= tolerance &&
               Math.abs(pixels[off + 1] - bg[1]) <= tolerance &&
               Math.abs(pixels[off + 2] - bg[2]) <= tolerance;
    }

    let minX = width, minY = height, maxX = 0, maxY = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!isBg((y * width + x) * 4)) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < minX || maxY < minY) {
        // Entirely background – return a 1x1 pixel with background color
        const px = Buffer.alloc(4);
        px[0] = bg[0]; px[1] = bg[1]; px[2] = bg[2]; px[3] = 255;
        return { width: 1, height: 1, pixels: px };
    }

    // Apply padding
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(width - 1, maxX + padding);
    maxY = Math.min(height - 1, maxY + padding);

    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    const cropped = Buffer.alloc(cw * ch * 4);

    for (let y = 0; y < ch; y++) {
        const srcOff = ((minY + y) * width + minX) * 4;
        const dstOff = y * cw * 4;
        pixels.copy(cropped, dstOff, srcOff, srcOff + cw * 4);
    }

    return { width: cw, height: ch, pixels: cropped };
}

/**
 * Encode raw RGBA pixels into a PNG buffer.
 */
function encodePNG(pixels, width, height) {
    // Build raw scanlines with filter byte 0 (None) per row
    const stride = width * 4;
    const rawBuf = Buffer.alloc(height * (1 + stride));
    for (let y = 0; y < height; y++) {
        rawBuf[y * (1 + stride)] = 0; // filter type None
        pixels.copy(rawBuf, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
    }

    const compressed = deflateSync(rawBuf);

    // Build PNG file
    const chunks = [];

    // Signature
    chunks.push(PNG_SIG);

    // Helper to write a chunk
    function writeChunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(typeAndData));
        chunks.push(len, typeAndData, crc);
    }

    // IHDR
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    writeChunk('IHDR', ihdr);

    // IDAT
    writeChunk('IDAT', compressed);

    // IEND
    writeChunk('IEND', Buffer.alloc(0));

    return Buffer.concat(chunks);
}

/**
 * Process a PNG buffer: make background transparent, auto-crop, re-encode.
 */
function processImage(pngBuf) {
    try {
        const { width, height, pixels } = decodePNG(pngBuf);
        const cropped = autoCrop(pixels, width, height);
        return encodePNG(cropped.pixels, cropped.width, cropped.height);
    } catch (err) {
        // If processing fails, return original image unchanged
        console.log(`  ⚠ Image processing failed: ${err.message}`);
        return pngBuf;
    }
}

// ── Process one file ─────────────────────────────────────────────────

function processSLDPRT(filePath, outputDir) {
    const name = basename(filePath, extname(filePath));
    const data = readFileSync(filePath);

    let pngs = [];

    if (data.length >= 8 && data.subarray(0, 8).equals(OLE2_SIG)) {
        // Legacy OLE2/CFB format (pre-2015)
        try {
            pngs = extractFromOLE2(data);
        } catch (err) {
            console.log(`  ⚠ ${basename(filePath)} — OLE2 parse error: ${err.message}`);
        }
    }

    // SW 3D Storage format (2015+) or OLE2 with no PNG found
    if (pngs.length === 0) {
        pngs = extractFromSW3DStorage(data);
    }

    // Raw scan fallback
    if (pngs.length === 0) {
        const raw = scanForRawPNG(data);
        if (raw && raw.length > 64) {
            pngs = [{ data: raw, offset: 0 }];
        }
    }

    if (pngs.length === 0) {
        console.log(`  ✗ ${basename(filePath)} — no thumbnail found`);
        return false;
    }

    // Write the main thumbnail (first in sorted order)
    const best = pngs[0];
    const outPath = join(outputDir, `${name}.png`);
    writeFileSync(outPath, processImage(best.data));

    // Write all additional sub-images (configuration views, etc.)
    for (let i = 1; i < pngs.length; i++) {
        const subPath = join(outputDir, `${name}_${i}.png`);
        writeFileSync(subPath, processImage(pngs[i].data));
    }

    const extra = pngs.length > 1 ? ` + ${pngs.length - 1} sub-image(s)` : '';
    console.log(`  ✓ ${basename(filePath)}  →  ${basename(outPath)}  (${best.data.length} → processed${extra})`);
    return true;
}

// ── Main ──────────────────────────────────────────────────────────────

const defaultFolder = resolve(__dirname, 'nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018');
const input = process.argv[2] ? resolve(process.argv[2]) : defaultFolder;

if (!existsSync(input)) {
    console.error(`Path not found: ${input}`);
    process.exit(1);
}

// Determine list of files
let files;
try {
    const s = statSync(input);
    if (s.isDirectory()) {
        files = readdirSync(input)
            .filter(f => /\.sldprt$/i.test(f))
            .map(f => join(input, f));
    } else {
        files = [input];
    }
} catch {
    files = [input];
}

if (files.length === 0) {
    console.error('No .SLDPRT files found.');
    process.exit(1);
}

// Output folder next to the input
const outputDir = join(
    files.length === 1 ? dirname(files[0]) : input,
    'thumbnails'
);
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

console.log(`Extracting thumbnails from ${files.length} file(s) → ${outputDir}\n`);

let ok = 0;
for (const f of files) {
    if (processSLDPRT(f, outputDir)) ok++;
}

console.log(`\nDone: ${ok}/${files.length} thumbnails extracted.`);
