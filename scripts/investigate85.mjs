#!/usr/bin/env node
// Clean-room analysis of public-domain NIST test files.
/**
 * investigate85.mjs — Deep analysis of FTC_11's =p/=q marker format
 * 
 * FTC_11 uses =p/=q markers, not the sentinel/compact format used by most files.
 * Currently extracts 125 vertices (brute-force) but only 3/53 match reference.
 * 
 * Goal: Understand the =p/=q record structure to extract vertices precisely.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const FILE = path.join(NIST_DIR, 'nist_ftc_11_asme1_rb_sw1802.SLDPRT');

const buf = fs.readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
if (!result) { console.log('No PS data'); process.exit(1); }
const psBuf = result.data;
console.log(`PS buffer: ${psBuf.length} bytes`);

// Parse header
const headerEnd = psBuf.indexOf(0x00, 5);
const header = psBuf.subarray(0, headerEnd).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
console.log(`Header: ${header}`);

// Schema
const schIdx = psBuf.indexOf('SCH_');
let schEnd = schIdx;
while (schEnd < psBuf.length && psBuf[schEnd] !== 0x00 && psBuf[schEnd] >= 0x20) schEnd++;
console.log(`Schema: ${psBuf.subarray(schIdx, schEnd).toString('ascii')}`);

// Find =p/=q markers
const markers = [];
for (let i = 0; i < psBuf.length - 1; i++) {
    if (psBuf[i] === 0x3d && (psBuf[i+1] === 0x70 || psBuf[i+1] === 0x71)) {
        markers.push({ offset: i, type: psBuf[i+1] === 0x70 ? 'p' : 'q' });
    }
}
console.log(`\nTotal markers: ${markers.length} (${markers.filter(m => m.type === 'p').length} =p, ${markers.filter(m => m.type === 'q').length} =q)`);

// Check for sentinels
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
let sentCount = 0;
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) { sentCount++; idx += 6; }
console.log(`Sentinels: ${sentCount}`);

// Analyze each marker record
console.log('\n=== Marker Record Analysis ===');
for (let mi = 0; mi < markers.length; mi++) {
    const m = markers[mi];
    const recordEnd = mi + 1 < markers.length ? markers[mi+1].offset : psBuf.length;
    const recordSize = recordEnd - m.offset;
    
    // =p header: =p (2B) + tag (3B) → data at +5
    // =q header: =q (2B) → data at +2
    const headerSize = m.type === 'p' ? 5 : 2;
    const dataStart = m.offset + headerSize;
    const data = psBuf.subarray(dataStart, recordEnd);
    
    // Read tag bytes for =p records
    const tag = m.type === 'p' ? 
        `tag=[${psBuf[m.offset+2].toString(16)}, ${psBuf[m.offset+3].toString(16)}, ${psBuf[m.offset+4].toString(16)}]` : 
        '';
    
    // Count float64 BE values that look like coordinates
    const floats = [];
    for (let off = 0; off + 8 <= data.length; off += 8) {
        const val = data.readDoubleBE(off);
        if (isFinite(val) && Math.abs(val) < 100) {
            floats.push({ offset: off, value: val });
        }
    }
    
    // Count float64 triplets that look like coordinates (meters range)
    const triplets = [];
    for (let off = 0; off + 24 <= data.length; off += 8) {
        const x = data.readDoubleBE(off);
        const y = data.readDoubleBE(off + 8);
        const z = data.readDoubleBE(off + 16);
        if (isFinite(x) && isFinite(y) && isFinite(z) &&
            Math.abs(x) < 10 && Math.abs(y) < 10 && Math.abs(z) < 10 &&
            (Math.abs(x) + Math.abs(y) + Math.abs(z)) > 1e-10) {
            triplets.push({ offset: off, x, y, z });
        }
    }
    
    if (mi < 50 || triplets.length > 0) {
        console.log(`\n[${mi}] =${m.type} at 0x${m.offset.toString(16)} size=${recordSize}B ${tag}`);
        if (triplets.length > 0) {
            for (const t of triplets) {
                console.log(`  triplet@${t.offset}: (${(t.x*1000).toFixed(2)}, ${(t.y*1000).toFixed(2)}, ${(t.z*1000).toFixed(2)}) mm`);
            }
        }
        // Show first 64 bytes hex
        const preview = data.subarray(0, Math.min(64, data.length));
        const hex = [...preview].map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`  hex: ${hex}`);
    }
}

// Now let's also try to find coordinate data by looking at the reference STEP file
// to know what coordinates to expect
const refDir = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'STEP AP242');
const refFiles = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter(f => /ftc_11/i.test(f)) : [];
console.log(`\nReference files: ${refFiles.join(', ') || 'none found'}`);

// Also check the output STEP file for the 3 vertices that DO match
const outFile = path.join('output', 'nist_ftc_11_asme1_rb_sw1802.stp');
if (fs.existsSync(outFile)) {
    const stepText = fs.readFileSync(outFile, 'utf-8');
    const vertexLines = stepText.split('\n').filter(l => /CARTESIAN_POINT/.test(l)).slice(0, 20);
    console.log(`\nFirst 20 CARTESIAN_POINTs in generated STEP:`);
    for (const l of vertexLines) {
        console.log(`  ${l.trim()}`);
    }
}

// Comprehensive: search for ANY float64 BE triplets that look like vertex coordinates
// in the entire PS buffer (not just marker records)
console.log('\n=== Full buffer vertex scan ===');
const allTriplets = [];
for (let off = 0; off + 24 <= psBuf.length; off++) {
    const x = psBuf.readDoubleBE(off);
    const y = psBuf.readDoubleBE(off + 8);
    const z = psBuf.readDoubleBE(off + 16);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (Math.abs(x) > 10 || Math.abs(y) > 10 || Math.abs(z) > 10) continue;
    if (x === 0 && y === 0 && z === 0) continue;
    const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
    if (mag < 1e-6) continue;
    
    // Check if this looks like a real coordinate (not just random pattern)
    // Real coordinates tend to have nice values when converted to mm
    const xmm = x * 1000, ymm = y * 1000, zmm = z * 1000;
    allTriplets.push({ offset: off, x: xmm, y: ymm, z: zmm });
}

// Deduplicate
const seen = new Set();
const unique = [];
for (const t of allTriplets) {
    const key = `${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
}

console.log(`Total unique triplets: ${unique.length}`);
console.log('First 30:');
for (const t of unique.slice(0, 30)) {
    console.log(`  0x${t.offset.toString(16)}: (${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}) mm`);
}
console.log('Last 30:');
for (const t of unique.slice(-30)) {
    console.log(`  0x${t.offset.toString(16)}: (${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}) mm`);
}
