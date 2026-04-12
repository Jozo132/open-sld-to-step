#!/usr/bin/env node
/**
 * investigate81.mjs — Analyze sentinel block structure to identify CURVE vs SURFACE.
 *
 * Hypothesis: Each sentinel block has a compact EDGE entity as "primary" and
 * sub-records include both CURVEs (for the edge) and SURFACEs (for nearby faces).
 * By analyzing sub-record counts per block and cross-referencing with FACE data,
 * we can classify type-0x1E entities as CURVE or SURFACE.
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

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

// Find sentinels
const sentinels = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0) { sentinels.push(si); si += 6; }
console.log(`PS buffer: ${ps.length} bytes, Sentinels: ${sentinels.length}\n`);

// ─── Extract compact entities by position ─────────────────────────────────
function findCompactEntities(buf) {
    const ents = [];
    for (let i = 0; i < buf.length - 9; i++) {
        if (buf[i] !== 0x00) continue;
        const type = buf[i + 1];
        if (type < 0x0F || type > 0x20) continue;
        if (buf[i + 4] !== 0x00 || buf[i + 5] !== 0x00) continue;
        if (buf[i + 8] !== 0x00 || buf[i + 9] !== 0x01) continue;
        const id = buf.readUInt16BE(i + 2);
        if (id === 0 || id > 60000) continue;
        ents.push({ pos: i, type, id, dataStart: i + 10 });
    }
    return ents;
}

const compactEnts = findCompactEntities(ps);
const compactById = new Map(compactEnts.map(e => [e.id, e]));
const compactByPos = new Map(compactEnts.map(e => [e.pos, e]));

// ─── Analyze sentinel blocks and their contents ─────────────────────────────
// For each sentinel, find:
// 1. What compact entities are in this block (between this sentinel and next)
// 2. How many sub-records of each type

const blockAnalysis = [];

for (let bi = 0; bi < sentinels.length; bi++) {
    const sentPos = sentinels[bi];
    const blockStart = sentPos + 6;
    const blockEnd = (bi + 1 < sentinels.length) ? sentinels[bi + 1] : ps.length;
    const blockSize = blockEnd - blockStart;
    
    // Find sub-record separators in this block
    const block = ps.subarray(blockStart, blockEnd);
    const subRecs = [];
    let searchIdx = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, searchIdx);
        if (sepIdx < 0) break;
        const recStart = sepIdx + SUB_SEP.length;
        if (recStart + 4 > block.length) break;
        const type = block[recStart + 1];
        const id = block.readUInt16BE(recStart + 2);
        subRecs.push({ type, id, blockOffset: recStart });
        searchIdx = recStart + 1;
    }
    
    // Find compact entities that fall within this block's byte range
    const compactsInBlock = compactEnts.filter(e => e.pos >= sentPos && e.pos < blockEnd);
    
    blockAnalysis.push({
        sentPos,
        blockSize,
        subRecs,
        compacts: compactsInBlock,
        subRecTypes: subRecs.map(r => r.type),
    });
}

// ─── Statistics ──────────────────────────────────────────────────────────────
console.log('=== Sentinel block statistics ===');

// Count blocks with N sub-records
const subRecCountDist = {};
for (const ba of blockAnalysis) {
    const key = ba.subRecs.length;
    subRecCountDist[key] = (subRecCountDist[key] || 0) + 1;
}
console.log('Sub-records per block:', JSON.stringify(subRecCountDist));

// Count blocks by sub-record type combinations
const typeCombo = {};
for (const ba of blockAnalysis) {
    const key = ba.subRecTypes.sort().map(t => `0x${t.toString(16)}`).join('+') || 'none';
    typeCombo[key] = (typeCombo[key] || 0) + 1;
}
console.log('\nSub-record type combos:', JSON.stringify(typeCombo, null, 2));

// Count blocks by compact entity types within
const compactCombo = {};
for (const ba of blockAnalysis) {
    const types = ba.compacts.map(c => `0x${c.type.toString(16)}`).sort().join('+') || 'none';
    compactCombo[types] = (compactCombo[types] || 0) + 1;
}
console.log('\nCompact entities in blocks:', JSON.stringify(compactCombo, null, 2));

// ─── Focus: blocks with type-0x1E sub-records ──────────────────────────────
console.log('\n=== Blocks with 0x1E sub-records ===');

let blocksWithSingle1E = 0;
let blocksWithMultiple1E = 0;
let blocksWithBoth1E1F = 0;

const surfaceSubRecIds = new Set();
const curveSubRecIds = new Set();

for (const ba of blockAnalysis) {
    const type1E = ba.subRecs.filter(r => r.type === 0x1E);
    const type1F = ba.subRecs.filter(r => r.type === 0x1F);
    const hasEdge = ba.compacts.some(c => c.type === 0x10);
    const hasFace = ba.compacts.some(c => c.type === 0x0F);
    
    if (type1E.length === 1) blocksWithSingle1E++;
    if (type1E.length > 1) blocksWithMultiple1E++;
    if (type1E.length > 0 && type1F.length > 0) blocksWithBoth1E1F++;
    
    // Classification: if block has EDGE + single 0x1E → it's a CURVE
    if (hasEdge && type1E.length === 1) {
        curveSubRecIds.add(type1E[0].id);
    }
    
    // If block has FACE + 0x1E → could be a SURFACE
    if (hasFace) {
        for (const sr of type1E) {
            surfaceSubRecIds.add(sr.id);
        }
    }
}

console.log(`Blocks with single 0x1E: ${blocksWithSingle1E}`);
console.log(`Blocks with multiple 0x1E: ${blocksWithMultiple1E}`);
console.log(`Blocks with both 0x1E and 0x1F: ${blocksWithBoth1E1F}`);
console.log(`Estimated CURVE IDs: ${curveSubRecIds.size}`);
console.log(`Estimated SURFACE IDs (in FACE blocks): ${surfaceSubRecIds.size}`);

// ─── Per-block detailed analysis (first 30 blocks with geometry) ────────────
console.log('\n=== Detailed block analysis (first 30 with geometry) ===');
let geomBlockCount = 0;
for (const ba of blockAnalysis) {
    if (ba.subRecs.length === 0) continue;
    if (geomBlockCount >= 30) break;
    geomBlockCount++;
    
    const compactTypes = ba.compacts.map(c => {
        const name = {0x0f:'FACE', 0x10:'EDGE', 0x11:'SHELL', 0x12:'COEDGE', 
                      0x1d:'POINT', 0x1e:'CURVE', 0x1f:'SURFACE'}[c.type] || `0x${c.type.toString(16)}`;
        return `${name}#${c.id}`;
    }).join(', ');
    
    const subRecTypesStr = ba.subRecs.map(r => {
        const name = {0x11:'SHELL', 0x1e:'CURVE', 0x1f:'SURFACE'}[r.type] || `0x${r.type.toString(16)}`;
        return `${name}#${r.id}`;
    }).join(', ');
    
    console.log(`  Block @${ba.sentPos} (${ba.blockSize}B): compacts=[${compactTypes}] subrecs=[${subRecTypesStr}]`);
}

// ─── Which 0x1E sub-record IDs match FACE data fields? ─────────────────────
console.log('\n=== 0x1E sub-record IDs vs FACE data field values ===');

const faceCompacts = compactEnts.filter(e => e.type === 0x0F);
const allSubRec1EIds = new Set();
for (const ba of blockAnalysis) {
    for (const sr of ba.subRecs) {
        if (sr.type === 0x1E) allSubRec1EIds.add(sr.id);
    }
}

// For each data field position in FACE entities, check how many values
// match a known 0x1E sub-record ID
console.log('FACE field → match with 0x1E sub-record IDs:');
for (let fi = 0; fi < 20; fi++) {
    let matchCount = 0;
    for (const face of faceCompacts) {
        const data = ps.subarray(face.dataStart, Math.min(face.dataStart + 44, ps.length));
        if (fi * 2 + 2 > data.length) continue;
        const val = data.readUInt16BE(fi * 2);
        if (allSubRec1EIds.has(val)) matchCount++;
    }
    if (matchCount > 0) {
        console.log(`  Field[${fi}]: ${matchCount}/${faceCompacts.length} match`);
    }
}

// Also check FACE flags field
let flagsMatch1E = 0;
let flagsMatch1F = 0;
const allSubRec1FIds = new Set();
for (const ba of blockAnalysis) {
    for (const sr of ba.subRecs) {
        if (sr.type === 0x1F) allSubRec1FIds.add(sr.id);
    }
}

for (const face of faceCompacts) {
    const ent = compactById.get(face.id);
    if (allSubRec1EIds.has(ent.flags)) flagsMatch1E++;
    if (allSubRec1FIds.has(ent.flags)) flagsMatch1F++;
}
console.log(`\nFACE flags → 0x1E match: ${flagsMatch1E}/${faceCompacts.length}`);
console.log(`FACE flags → 0x1F match: ${flagsMatch1F}/${faceCompacts.length}`);

// ─── FACE proximity to geometry entities ─────────────────────────────────────
// Each FACE compact entity is at a specific byte position.
// Find the NEAREST 0x1E sub-record to each FACE.
console.log('\n=== FACE proximity to nearest 0x1E sub-record ===');

// Build position → sub-record map
const subRec1EByPos = [];
for (const ba of blockAnalysis) {
    for (const sr of ba.subRecs) {
        if (sr.type === 0x1E || sr.type === 0x1F) {
            subRec1EByPos.push({ pos: ba.sentPos + 6 + sr.blockOffset, id: sr.id, type: sr.type });
        }
    }
}
subRec1EByPos.sort((a, b) => a.pos - b.pos);

// For first 20 faces, find nearest geometry entity
for (const face of faceCompacts.slice(0, 15)) {
    // Find nearest geometry sub-record
    let nearest = null;
    let nearestDist = Infinity;
    let nearestBefore = null;
    let nearestBeforeDist = Infinity;
    let nearestAfter = null;
    let nearestAfterDist = Infinity;
    
    for (const sr of subRec1EByPos) {
        const dist = Math.abs(sr.pos - face.pos);
        if (dist < nearestDist) { nearestDist = dist; nearest = sr; }
        if (sr.pos < face.pos && (face.pos - sr.pos) < nearestBeforeDist) {
            nearestBeforeDist = face.pos - sr.pos;
            nearestBefore = sr;
        }
        if (sr.pos > face.pos && (sr.pos - face.pos) < nearestAfterDist) {
            nearestAfterDist = sr.pos - face.pos;
            nearestAfter = sr;
        }
    }
    
    console.log(`  FACE #${face.id} @${face.pos}: ` +
        `before=0x${nearestBefore?.type.toString(16)}#${nearestBefore?.id}(${nearestBeforeDist}B) ` +
        `after=0x${nearestAfter?.type.toString(16)}#${nearestAfter?.id}(${nearestAfterDist}B)`);
}
