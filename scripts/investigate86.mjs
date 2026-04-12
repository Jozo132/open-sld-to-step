#!/usr/bin/env node
// Clean-room analysis of public-domain NIST test files.
/**
 * investigate86.mjs — Dump FTC_11 sentinel block contents and cross-reference
 * with reference STEP coordinates to find POINT entity format.
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
console.log(`PS buffer: ${psBuf.length} bytes\n`);

// Find all sentinel positions
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const sentPositions = [];
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) {
    sentPositions.push(idx);
    idx += SENTINEL.length;
}
console.log(`Sentinels at: ${sentPositions.map(p => '0x' + p.toString(16)).join(', ')}`);

// Dump each sentinel block
for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + SENTINEL.length;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    
    console.log(`\n=== Sentinel block ${i} (0x${blockStart.toString(16)}..0x${blockEnd.toString(16)}, ${block.length}B) ===`);
    
    // Full hex dump (limited to 256 bytes per block)
    const dumpLen = Math.min(block.length, 256);
    for (let off = 0; off < dumpLen; off += 32) {
        const slice = block.subarray(off, Math.min(off + 32, dumpLen));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const abs = blockStart + off;
        console.log(`  ${abs.toString(16).padStart(6, '0')}: ${hex}`);
    }
    if (block.length > 256) console.log(`  ... (${block.length - 256} more bytes)`);
    
    // Search for float64 triplets in this block
    for (let off = 0; off + 24 <= block.length; off += 8) {
        const x = block.readDoubleBE(off);
        const y = block.readDoubleBE(off + 8);
        const z = block.readDoubleBE(off + 16);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) continue;
        const xmm = x * 1000, ymm = y * 1000, zmm = z * 1000;
        const mag = Math.abs(xmm) + Math.abs(ymm) + Math.abs(zmm);
        if (mag < 0.01) continue;
        console.log(`  → float64 triplet@${off}: (${xmm.toFixed(3)}, ${ymm.toFixed(3)}, ${zmm.toFixed(3)}) mm`);
    }
}

// Also dump the section BEFORE the first sentinel (packed entity data)
console.log('\n=== Pre-sentinel data ===');
const preData = psBuf.subarray(0, sentPositions[0] || psBuf.length);
console.log(`Pre-sentinel region: ${preData.length} bytes (0x0..0x${(sentPositions[0] || psBuf.length).toString(16)})`);

// Look for float64 triplets in pre-sentinel region
console.log('\nFloat64 triplets in pre-sentinel (8-byte aligned):');
for (let off = 0; off + 24 <= preData.length; off += 8) {
    const x = preData.readDoubleBE(off);
    const y = preData.readDoubleBE(off + 8);
    const z = preData.readDoubleBE(off + 16);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) continue;
    const xmm = x * 1000, ymm = y * 1000, zmm = z * 1000;
    const mag = Math.abs(xmm) + Math.abs(ymm) + Math.abs(zmm);
    if (mag < 0.01) continue;
    console.log(`  0x${off.toString(16)}: (${xmm.toFixed(3)}, ${ymm.toFixed(3)}, ${zmm.toFixed(3)}) mm`);
}

// Cross-reference with reference STEP coordinates
const refPath = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'FTC Definitions', 'nist_ftc_11_asme1_rb.stp');
const refText = fs.readFileSync(refPath, 'utf-8');
const cartPoints = [];
const cpRegex = /CARTESIAN_POINT\([^,]*,\(([^)]+)\)\)/g;
let match;
while ((match = cpRegex.exec(refText)) !== null) {
    const vals = match[1].split(',').map(Number);
    if (vals.length === 3) cartPoints.push({ x: vals[0], y: vals[1], z: vals[2] });
}

// Deduplicate
const refSeen = new Set();
const uniqueRef = [];
for (const p of cartPoints) {
    const key = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
    if (refSeen.has(key)) continue;
    refSeen.add(key);
    uniqueRef.push(p);
}
console.log(`\n=== Reference STEP: ${uniqueRef.length} unique CARTESIAN_POINT coordinates ===`);
for (const p of uniqueRef) {
    console.log(`  (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) mm`);
}

// For each reference coordinate, search for it in the PS binary
console.log('\n=== Searching for reference coordinates in PS binary ===');
for (const p of uniqueRef.slice(0, 20)) {
    // Convert mm to meters for PS comparison
    const xm = p.x / 1000, ym = p.y / 1000, zm = p.z / 1000;
    
    // Search at every byte offset
    for (let off = 0; off + 24 <= psBuf.length; off++) {
        const x = psBuf.readDoubleBE(off);
        const y = psBuf.readDoubleBE(off + 8);
        const z = psBuf.readDoubleBE(off + 16);
        if (Math.abs(x - xm) < 1e-8 && Math.abs(y - ym) < 1e-8 && Math.abs(z - zm) < 1e-8) {
            // Show context bytes around this match
            const ctx = psBuf.subarray(Math.max(0, off - 8), Math.min(off + 32, psBuf.length));
            const hex = [...ctx].map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`  (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})mm found at 0x${off.toString(16)} context: ${hex}`);
            break;
        }
    }
}
