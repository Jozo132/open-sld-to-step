/**
 * investigate6.mjs — Deep analysis of Parasolid binary transmit format
 *
 * Goal: understand the byte-level structure of the .x_b stream so we can
 * parse entity records and extract coordinates structurally.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));

const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function extractParasolid(filePath) {
    const buf = readFileSync(filePath);
    let idx = 0;
    while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const compressedSize = buf.readUInt32LE(idx + 14);
        const decompressedSize = buf.readUInt32LE(idx + 18);
        const nameLength = buf.readUInt32LE(idx + 22);
        if (nameLength > 0 && nameLength < 1024 && compressedSize > 4 &&
            compressedSize < buf.length && decompressedSize > 4 && decompressedSize < 50_000_000) {
            const payloadOffset = idx + 26 + nameLength;
            const payloadEnd = payloadOffset + compressedSize;
            if (payloadEnd <= buf.length) {
                try {
                    const outer = inflateRawSync(buf.subarray(payloadOffset, payloadEnd),
                        { maxOutputLength: decompressedSize + 1024 });
                    // Try nested decompression at byte 28
                    if (outer.length > 28 && outer[28] === 0x78) {
                        try {
                            const inner = inflateSync(outer.subarray(28));
                            if (inner.length >= 20 && inner[0] === 0x50 && inner[1] === 0x53) {
                                return inner;
                            }
                        } catch {}
                    }
                    // Direct Parasolid check
                    if (outer.length >= 20 && outer[0] === 0x50 && outer[1] === 0x53) {
                        return outer;
                    }
                } catch {}
            }
        }
        idx++;
    }
    return null;
}

// Use first file for analysis
const ps = extractParasolid(join(dir, files[0]));
if (!ps) { console.log('No Parasolid data found'); process.exit(1); }

console.log(`Parasolid buffer: ${ps.length} bytes from ${files[0]}\n`);

// 1. Show the header (first ~200 bytes as printable ASCII)
console.log('=== HEADER (first 200 bytes, printable) ===');
const headerText = ps.subarray(0, 200).toString('ascii').replace(/[^\x20-\x7e]/g, '·');
console.log(headerText);
console.log('');

// 2. Find the header end (first NUL or newline sequence)
let headerEnd = 0;
for (let i = 0; i < Math.min(ps.length, 256); i++) {
    if (ps[i] === 0x0A || ps[i] === 0x0D) { headerEnd = i; break; }
}
console.log(`Header ends at byte ${headerEnd}`);
console.log('');

// 3. Show bytes after header for 500 bytes
console.log('=== POST-HEADER (next 500 bytes, hex + ascii) ===');
for (let off = headerEnd; off < Math.min(ps.length, headerEnd + 500); off += 32) {
    const slice = ps.subarray(off, Math.min(off + 32, ps.length));
    const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
    console.log(`${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
}
console.log('');

// 4. Find all =p and =q markers and show context
const RECORD_PREFIX = 0x3d;
const RECORD_P = 0x70;
const RECORD_Q = 0x71;
const markers = [];
for (let i = 0; i < ps.length - 1; i++) {
    if (ps[i] === RECORD_PREFIX && (ps[i + 1] === RECORD_P || ps[i + 1] === RECORD_Q)) {
        markers.push({ offset: i, type: ps[i + 1] === RECORD_P ? 'p' : 'q' });
    }
}
console.log(`=== RECORD MARKERS: ${markers.length} total (=p and =q) ===`);
for (const m of markers.slice(0, 10)) {
    const ctx = ps.subarray(m.offset, Math.min(m.offset + 64, ps.length));
    const hex = [...ctx].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...ctx].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
    console.log(`  =${m.type} at 0x${m.offset.toString(16)}: ${hex}`);
    console.log(`    ascii: ${ascii}`);
}
if (markers.length > 10) console.log(`  ... and ${markers.length - 10} more`);
console.log('');

// 5. Look for the SCH_ schema identifier and dump what follows
const schIdx = ps.indexOf('SCH_', 0, 'ascii');
if (schIdx >= 0) {
    console.log(`=== SCHEMA section found at byte ${schIdx} ===`);
    const schSlice = ps.subarray(schIdx, Math.min(schIdx + 200, ps.length));
    const schText = schSlice.toString('ascii').replace(/[^\x20-\x7e]/g, '·');
    console.log(schText);
    console.log('');
    
    // Hex dump of schema area
    for (let off = schIdx; off < Math.min(ps.length, schIdx + 300); off += 32) {
        const slice = ps.subarray(off, Math.min(off + 32, ps.length));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        console.log(`${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
}
console.log('');

// 6. Find known entity class name strings and their byte contexts
const entityNames = ['BODY', 'SHELL', 'FACE', 'LOOP', 'EDGE', 'VERTEX', 'POINT', 'SURFACE', 'CURVE', 'PLANE', 'LINE', 'CIRCLE'];
console.log('=== ENTITY CLASS NAME OCCURRENCES ===');
for (const name of entityNames) {
    const positions = [];
    let searchStart = 0;
    while (true) {
        const idx = ps.indexOf(name, searchStart, 'ascii');
        if (idx < 0) break;
        positions.push(idx);
        searchStart = idx + 1;
    }
    console.log(`  ${name}: ${positions.length} occurrences at ${positions.slice(0, 5).map(p => '0x' + p.toString(16)).join(', ')}${positions.length > 5 ? '...' : ''}`);
}
console.log('');

// 7. Look for float64 values that could be coordinates near POINT occurrences
console.log('=== FLOAT64 NEAR "POINT" OCCURRENCES ===');
let searchStart = 0;
let pointCount = 0;
while (pointCount < 5) {
    const idx = ps.indexOf('POINT', searchStart, 'ascii');
    if (idx < 0) break;
    searchStart = idx + 1;
    pointCount++;
    
    console.log(`  POINT at 0x${idx.toString(16)}:`);
    // Show 128 bytes after the POINT string
    const start = idx;
    const end = Math.min(idx + 128, ps.length);
    for (let off = start; off < end; off += 32) {
        const slice = ps.subarray(off, Math.min(off + 32, ps.length));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        console.log(`    ${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
    
    // Try reading float64 at various offsets after "POINT"
    for (let foff = idx + 5; foff + 24 <= ps.length && foff < idx + 80; foff++) {
        const x = ps.readDoubleLE(foff);
        const y = ps.readDoubleLE(foff + 8);
        const z = ps.readDoubleLE(foff + 16);
        if (isFinite(x) && isFinite(y) && isFinite(z) &&
            Math.abs(x) < 1e6 && Math.abs(y) < 1e6 && Math.abs(z) < 1e6 &&
            (Math.abs(x) + Math.abs(y) + Math.abs(z)) > 1e-10) {
            console.log(`    → float64 triplet at +${foff - idx}: (${x}, ${y}, ${z})`);
        }
    }
    console.log('');
}

// 8. Check if this is actually a TEXT transmit file (.x_t) rather than binary
console.log('=== FORMAT CHECK ===');
// Count printable vs non-printable bytes in first 1KB after header
let printable = 0, nonPrintable = 0;
for (let i = headerEnd; i < Math.min(ps.length, headerEnd + 1024); i++) {
    if (ps[i] >= 0x20 && ps[i] <= 0x7e || ps[i] === 0x0A || ps[i] === 0x0D || ps[i] === 0x09) {
        printable++;
    } else {
        nonPrintable++;
    }
}
const pctPrintable = (100 * printable / (printable + nonPrintable)).toFixed(1);
console.log(`Post-header 1KB: ${printable} printable, ${nonPrintable} non-printable (${pctPrintable}% text)`);
if (parseFloat(pctPrintable) > 80) {
    console.log('  → This looks like a TEXT transmit file (.x_t)!');
    console.log('  → First 2000 chars of body:');
    console.log(ps.subarray(headerEnd, headerEnd + 2000).toString('ascii'));
}
