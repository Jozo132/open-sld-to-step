/**
 * investigate8.mjs — Deep-dive into the REAL Parasolid geometry section
 * Clean-room analysis of public-domain NIST test files.
 *
 * Section §15 @14457 has 129,095 bytes with 106 =p and 24 =q markers,
 * plus BODY and FACE class names. THIS is the actual geometry.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function extractLargestParasolid(filePath) {
    const buf = readFileSync(filePath);
    let idx = 0;
    let best = null;
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
                    const dec = inflateRawSync(buf.subarray(payloadOffset, payloadEnd),
                        { maxOutputLength: decompressedSize + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const inner = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (inner.length >= 20 && inner[0] === 0x50 && inner[1] === 0x53) {
                                if (!best || inner.length > best.length) {
                                    best = inner;
                                }
                            }
                        } catch {}
                    }
                    if (dec.length >= 20 && dec[0] === 0x50 && dec[1] === 0x53) {
                        if (!best || dec.length > best.length) best = dec;
                    }
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

const ps = extractLargestParasolid(join(dir, files[0]));
console.log(`Parasolid buffer: ${ps.length} bytes\n`);

// 1. Header
const headerEnd = ps.indexOf(0x00, 5); // after "PS\0\0\0"
console.log('=== HEADER ===');
console.log(ps.subarray(0, headerEnd).toString('ascii').replace(/[^\x20-\x7e]/g, '.'));
console.log(`Header ends at byte ${headerEnd}\n`);

// 2. Schema section
const schIdx = ps.indexOf('SCH_', 0, 'ascii');
console.log(`Schema at byte ${schIdx}`);
let schEnd = schIdx;
while (schEnd < ps.length && ps[schEnd] !== 0x00) schEnd++;
console.log(`Schema ID: ${ps.subarray(schIdx, schEnd).toString('ascii')}\n`);

// 3. Find entity class names and their positions
const entityNames = ['BODY', 'REGION', 'LUMP', 'SHELL', 'FACE', 'LOOP', 'FIN',
    'EDGE', 'VERTEX', 'POINT', 'CURVE', 'SURFACE', 'PLANE', 'LINE', 'CIRCLE',
    'ELLIPSE', 'BCURVE', 'BSURF', 'CONE', 'SPHERE', 'TORUS', 'BSURFACE',
    'CONE_CURVE', 'PCURVE', 'SP_CURVE', 'TRIMMED'];

console.log('=== ENTITY CLASS NAMES ===');
for (const name of entityNames) {
    const positions = [];
    let s = 0;
    while (true) {
        const idx = ps.indexOf(name, s, 'ascii');
        if (idx < 0) break;
        positions.push(idx);
        s = idx + 1;
        if (positions.length > 20) break;
    }
    if (positions.length > 0) {
        console.log(`  ${name}: ${positions.length} at ${positions.slice(0, 5).map(p => '0x' + p.toString(16)).join(', ')}`);
    }
}
console.log('');

// 4. Analyze =p and =q record structure
console.log('=== RECORD ANALYSIS (=p and =q markers) ===');
const markers = [];
for (let i = 0; i < ps.length - 1; i++) {
    if (ps[i] === 0x3d && (ps[i + 1] === 0x70 || ps[i + 1] === 0x71)) {
        markers.push({ offset: i, type: ps[i + 1] === 0x70 ? 'p' : 'q' });
    }
}
console.log(`Total markers: ${markers.length} (=p: ${markers.filter(m=>m.type==='p').length}, =q: ${markers.filter(m=>m.type==='q').length})`);

// Show distances between consecutive markers
if (markers.length > 1) {
    const gaps = [];
    for (let i = 1; i < markers.length; i++) {
        gaps.push(markers[i].offset - markers[i-1].offset);
    }
    console.log(`Record sizes (gaps between markers): min=${Math.min(...gaps)} max=${Math.max(...gaps)} avg=${(gaps.reduce((a,b)=>a+b,0)/gaps.length).toFixed(0)}`);
}
console.log('');

// 5. Show first 15 =p records with hex dump and float64 attempts
console.log('=== FIRST 15 RECORDS (hex + float64 attempts) ===\n');
for (const m of markers.slice(0, 15)) {
    const nextMarker = markers.find(mm => mm.offset > m.offset);
    const end = nextMarker ? nextMarker.offset : Math.min(m.offset + 256, ps.length);
    const recordLen = end - m.offset;
    const record = ps.subarray(m.offset, end);
    
    console.log(`=${m.type} at 0x${m.offset.toString(16)} (${recordLen} bytes):`);
    
    // Show first 96 bytes hex
    for (let off = 0; off < Math.min(record.length, 96); off += 32) {
        const slice = record.subarray(off, Math.min(off + 32, record.length));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        console.log(`  ${(m.offset + off).toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
    
    // Try reading float64 at every byte offset in the record 
    const floats = [];
    for (let foff = 2; foff + 8 <= record.length; foff++) {
        const val = record.readDoubleLE(foff);
        if (isFinite(val) && Math.abs(val) > 1e-10 && Math.abs(val) < 1e6 && val !== 0) {
            floats.push({ offset: foff, value: val });
        }
    }
    if (floats.length > 0) {
        console.log(`  Float64 candidates: ${floats.map(f => `+${f.offset}:${f.value.toFixed(4)}`).join(', ')}`);
    }
    console.log('');
}

// 6. Look at the structure between header and first =p record
if (markers.length > 0) {
    console.log('=== STRUCTURE BETWEEN SCHEMA AND FIRST RECORD ===');
    const firstRec = markers[0].offset;
    const schemaEnd = schEnd + 1; // byte after schema null terminator
    console.log(`Schema ends at 0x${schemaEnd.toString(16)}, first record at 0x${firstRec.toString(16)}`);
    console.log(`Gap: ${firstRec - schemaEnd} bytes\n`);
    
    // Hex dump of the gap (first 800 bytes of it)
    for (let off = schemaEnd; off < Math.min(firstRec, schemaEnd + 800); off += 32) {
        const slice = ps.subarray(off, Math.min(off + 32, ps.length));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        console.log(`${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
}
