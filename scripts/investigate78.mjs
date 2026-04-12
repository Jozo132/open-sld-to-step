#!/usr/bin/env node
/**
 * investigate78.mjs — Census entities using [00 03 00 TYPE] pattern and
 * dump raw entity data for FACE (0x0F), EDGE (0x10), LOOP (0x13) entities.
 *
 * Goal: Find ALL topology entity positions (not just sentinel-block ones)
 * and try to extract int16 references from their data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const FILE = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const buf = fs.readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
if (!result) { console.log('No PS data'); process.exit(1); }
const ps = result.data;
console.log(`PS buffer: ${ps.length} bytes`);

// Sentinel positions
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const sentinels = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0) { sentinels.push(si); si += 6; }
console.log(`Sentinels: ${sentinels.length}`);
console.log(`First sentinel: ${sentinels[0]}, Last: ${sentinels[sentinels.length-1]}`);

// ─── Entity census via [00 03 00 TYPE] pattern ──────────────────────────────
const entityPositions = {};  // type → [positions]

for (let i = 0; i < ps.length - 3; i++) {
    if (ps[i] === 0x00 && ps[i+1] === 0x03 && ps[i+2] === 0x00) {
        const type = ps[i+3];
        if (type >= 0x0f && type <= 0x3f) {
            if (!entityPositions[type]) entityPositions[type] = [];
            entityPositions[type].push(i);
        }
    }
}

console.log('\n=== Entity census via [00 03 00 TYPE] ===');
for (const [type, positions] of Object.entries(entityPositions).sort((a,b) => b[1].length - a[1].length)) {
    const t = parseInt(type);
    console.log(`  0x${t.toString(16).padStart(2,'0')}: ${positions.length} entities`);
}

// ─── Classify positions: in sentinel blocks vs standalone ───────────────────
function isInSentinelBlock(pos) {
    for (let si = 0; si < sentinels.length - 1; si++) {
        if (pos >= sentinels[si] && pos < sentinels[si+1]) return true;
    }
    return pos >= sentinels[sentinels.length - 1];
}

console.log('\n=== In-sentinel vs standalone ===');
for (const [type, positions] of Object.entries(entityPositions)) {
    const t = parseInt(type);
    const inSent = positions.filter(p => isInSentinelBlock(p)).length;
    const outSent = positions.length - inSent;
    if (positions.length > 5) {
        console.log(`  0x${t.toString(16).padStart(2,'0')}: ${inSent} in sentinel, ${outSent} standalone`);
    }
}

// ─── Analyze FACE entities (type 0x0F = 15) ─────────────────────────────────
const facePos = entityPositions[0x0f] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`FACE entities (0x0F): ${facePos.length}`);
console.log(`${'='.repeat(60)}`);

// The [00 03 00 0F] pattern is at the MIDDLE of the primary entity header:
// Full header: [00 00 00 03] [00 0F] [ID_hi ID_lo]
// So the pattern starts at offset+2 of the full header, meaning the entity
// starts 2 bytes BEFORE our match position.

// For each FACE entity, the entity header is at (pos-2):
// [00 00] [00 03] [00 0F] [ID_hi] [ID_lo] [data...]
// pos-2    pos     pos+2   pos+4   pos+5

for (let fi = 0; fi < Math.min(facePos.length, 20); fi++) {
    const pos = facePos[fi];
    const headerStart = pos - 2;
    const id = ps.readUInt16BE(pos + 4);
    
    // Read data bytes after the 8-byte header
    const dataStart = headerStart + 8;
    const dataEnd = Math.min(dataStart + 40, ps.length);
    const data = ps.subarray(dataStart, dataEnd);
    
    // Parse data as uint16 BE references
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(data.length, 30); off += 2) {
        refs.push(data.readUInt16BE(off));
    }
    
    const hex = [...data.subarray(0, Math.min(30, data.length))]
        .map(b => b.toString(16).padStart(2,'0')).join(' ');
    
    console.log(`\nFACE #${id} @${headerStart}:`);
    console.log(`  hex: ${hex}`);
    console.log(`  refs: [${refs.join(', ')}]`);
    
    // Check context: what's before this entity?
    const beforeStart = Math.max(0, headerStart - 16);
    const before = ps.subarray(beforeStart, headerStart);
    const beforeHex = [...before].map(b => b.toString(16).padStart(2,'0')).join(' ');
    console.log(`  before: ${beforeHex}`);
}

// ─── Analyze EDGE entities (type 0x10 = 16) ─────────────────────────────────
const edgePos = entityPositions[0x10] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`EDGE entities (0x10): ${edgePos.length}`);
console.log(`${'='.repeat(60)}`);

for (let ei = 0; ei < Math.min(edgePos.length, 10); ei++) {
    const pos = edgePos[ei];
    const headerStart = pos - 2;
    const id = ps.readUInt16BE(pos + 4);
    
    const dataStart = headerStart + 8;
    const dataEnd = Math.min(dataStart + 40, ps.length);
    const data = ps.subarray(dataStart, dataEnd);
    
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(data.length, 30); off += 2) {
        refs.push(data.readUInt16BE(off));
    }
    
    const hex = [...data.subarray(0, Math.min(30, data.length))]
        .map(b => b.toString(16).padStart(2,'0')).join(' ');
    
    console.log(`\nEDGE #${id} @${headerStart}:`);
    console.log(`  hex: ${hex}`);
    console.log(`  refs: [${refs.join(', ')}]`);
}

// ─── Analyze COEDGE entities (type 0x12 = 18) ──────────────────────────────
const coedgePos = entityPositions[0x12] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`COEDGE entities (0x12): ${coedgePos.length}`);
console.log(`${'='.repeat(60)}`);

for (let ci = 0; ci < Math.min(coedgePos.length, 10); ci++) {
    const pos = coedgePos[ci];
    const headerStart = pos - 2;
    const id = ps.readUInt16BE(pos + 4);
    
    const dataStart = headerStart + 8;
    const dataEnd = Math.min(dataStart + 40, ps.length);
    const data = ps.subarray(dataStart, dataEnd);
    
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(data.length, 30); off += 2) {
        refs.push(data.readUInt16BE(off));
    }
    
    const hex = [...data.subarray(0, Math.min(30, data.length))]
        .map(b => b.toString(16).padStart(2,'0')).join(' ');
    
    console.log(`\nCOEDGE #${id} @${headerStart}:`);
    console.log(`  hex: ${hex}`);
    console.log(`  refs: [${refs.join(', ')}]`);
}

// ─── Analyze LOOP entities (type 0x13 = 19) ────────────────────────────────
const loopPos = entityPositions[0x13] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`LOOP entities (0x13): ${loopPos.length}`);
console.log(`${'='.repeat(60)}`);

for (let li = 0; li < Math.min(loopPos.length, 10); li++) {
    const pos = loopPos[li];
    const headerStart = pos - 2;
    const id = ps.readUInt16BE(pos + 4);
    
    const dataStart = headerStart + 8;
    const dataEnd = Math.min(dataStart + 40, ps.length);
    const data = ps.subarray(dataStart, dataEnd);
    
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(data.length, 30); off += 2) {
        refs.push(data.readUInt16BE(off));
    }
    
    const hex = [...data.subarray(0, Math.min(30, data.length))]
        .map(b => b.toString(16).padStart(2,'0')).join(' ');
    
    console.log(`\nLOOP #${id} @${headerStart}:`);
    console.log(`  hex: ${hex}`);
    console.log(`  refs: [${refs.join(', ')}]`);
}

// ─── Analyze POINT entities (type 0x1D = 29) ───────────────────────────────
const pointPos = entityPositions[0x1d] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`POINT entities (0x1D): ${pointPos.length}`);
console.log(`${'='.repeat(60)}`);

for (let pi = 0; pi < Math.min(pointPos.length, 5); pi++) {
    const pos = pointPos[pi];
    const headerStart = pos - 2;
    const id = ps.readUInt16BE(pos + 4);
    
    const dataStart = headerStart + 8;
    const dataEnd = Math.min(dataStart + 42, ps.length);
    const data = ps.subarray(dataStart, dataEnd);
    
    // Expected: 3 refs (6 bytes) + 3 × float64 (24 bytes) = 30 bytes total data
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(data.length, 6); off += 2) {
        refs.push(data.readUInt16BE(off));
    }
    
    let x = 0, y = 0, z = 0;
    if (data.length >= 30) {
        x = data.readDoubleBE(6) * 1000; // meters → mm
        y = data.readDoubleBE(14) * 1000;
        z = data.readDoubleBE(22) * 1000;
    }
    
    console.log(`\nPOINT #${id} @${headerStart}: refs=[${refs.join(',')}] → (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) mm`);
}

// ─── Cross-reference analysis: which entity types do FACE refs point to? ──
console.log(`\n${'='.repeat(60)}`);
console.log('FACE cross-reference analysis');
console.log(`${'='.repeat(60)}`);

// Build entity ID → type map from ALL [00 03 00 TYPE] entities
const idToType = new Map();
for (const [type, positions] of Object.entries(entityPositions)) {
    const t = parseInt(type);
    for (const pos of positions) {
        const id = ps.readUInt16BE(pos + 4);
        idToType.set(id, t);
    }
}
console.log(`Total entity IDs mapped: ${idToType.size}`);

// For each FACE, check which entity types its ref fields point to
console.log('\nFACE ref field → entity type mapping:');
const refFieldTypes = Array(15).fill(null).map(() => ({})); // typeHits per field

for (const pos of facePos) {
    const headerStart = pos - 2;
    const dataStart = headerStart + 8;
    const data = ps.subarray(dataStart, Math.min(dataStart + 30, ps.length));
    
    for (let fi = 0; fi + 2 <= Math.min(data.length, 30); fi += 2) {
        const ref = data.readUInt16BE(fi);
        const fieldIdx = fi / 2;
        if (ref > 0 && idToType.has(ref)) {
            const refType = idToType.get(ref);
            const key = `0x${refType.toString(16)}`;
            refFieldTypes[fieldIdx][key] = (refFieldTypes[fieldIdx][key] || 0) + 1;
        }
    }
}

for (let fi = 0; fi < 15; fi++) {
    const hits = refFieldTypes[fi];
    const total = Object.values(hits).reduce((a, b) => a + b, 0);
    if (total > 0) {
        console.log(`  Field[${fi}] (byte offset ${fi*2}): ${JSON.stringify(hits)} (${total}/${facePos.length} match)`);
    }
}
