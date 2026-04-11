#!/usr/bin/env node
/**
 * investigate66.mjs — Examine raw type-0x1E entity headers to find
 * distinguishing bytes between LINE curves and PLANE surfaces.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const PS_TO_MM = 1000;
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const buf = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const result = SldprtContainerParser.extractParasolid(buf);
const data = result.data;

// Find all sentinel positions
const sents = [];
let idx = 0;
while ((idx = data.indexOf(SENTINEL, idx)) >= 0) {
    sents.push(idx);
    idx += SENTINEL.length;
}

// Extract all type-0x1E sub-record entities with their raw data+header
const entities = [];
for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + SENTINEL.length;
    const blockEnd = i + 1 < sents.length ? sents[i + 1] : data.length;
    const block = data.subarray(blockStart, blockEnd);
    
    // Split by SUB_RECORD_SEP
    const subRecords = [];
    let searchStart = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
        if (sepIdx < 0) { subRecords.push(block.subarray(searchStart)); break; }
        subRecords.push(block.subarray(searchStart, sepIdx));
        searchStart = sepIdx + SUB_RECORD_SEP.length;
    }
    
    for (let si = 0; si < subRecords.length; si++) {
        const rec = subRecords[si];
        let type, id, entityData;
        if (si === 0) {
            if (rec.length < 8 || rec.readUInt32BE(0) !== 3) continue;
            type = rec[5]; id = rec.readUInt16BE(6); entityData = rec.subarray(8);
        } else {
            if (rec.length < 4 || rec[0] !== 0x00) continue;
            type = rec[1]; id = rec.readUInt16BE(2); entityData = rec.subarray(4);
        }
        if (type !== 0x1e) continue;
        
        // Read geometry floats
        const markerIdx = entityData.indexOf(0x2b);
        if (markerIdx < 0) continue;
        const floats = [];
        for (let off = markerIdx + 1; off + 8 <= entityData.length; off += 8) {
            const val = entityData.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }
        if (floats.length < 7) continue;
        if (floats.length > 8) continue; // skip cylinders etc.
        
        const origin = { x: floats[0]*PS_TO_MM, y: floats[1]*PS_TO_MM, z: floats[2]*PS_TO_MM };
        const normal = { x: floats[3], y: floats[4], z: floats[5] };
        const mag = Math.sqrt(normal.x**2+normal.y**2+normal.z**2);
        if (mag < 0.9 || mag > 1.1) continue;
        normal.x /= mag; normal.y /= mag; normal.z /= mag;
        
        const d = origin.x*normal.x + origin.y*normal.y + origin.z*normal.z;
        
        // Dump the header bytes before the 0x2B marker
        const headerBytes = entityData.subarray(0, markerIdx);
        
        entities.push({
            id, floatCount: floats.length,
            origin, normal, d,
            headerHex: [...headerBytes].map(b => b.toString(16).padStart(2,'0')).join(' '),
            headerLength: headerBytes.length,
            headerBytes,
        });
    }
}

console.log(`Total type-0x1E 7/8-float entities: ${entities.length}`);

// Load reference to identify which are real planes
const refStep = fs.readFileSync('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_01_asme1_rd.stp', 'utf8');
function parseRefPlanes(text) {
    const planes = [];
    const re = /PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const axId = m[1];
        const axRe = new RegExp(`#${axId}\\s*=\\s*AXIS2_PLACEMENT_3D\\s*\\(\\s*'[^']*'\\s*,\\s*#(\\d+)\\s*,\\s*#(\\d+)`);
        const am = text.match(axRe);
        if (!am) continue;
        const ptRe = new RegExp(`#${am[1]}\\s*=\\s*CARTESIAN_POINT\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
        const dirRe = new RegExp(`#${am[2]}\\s*=\\s*DIRECTION\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
        const pm = text.match(ptRe);
        const dm = text.match(dirRe);
        if (!pm || !dm) continue;
        const origin = pm[1].split(',').map(Number);
        const normal = dm[1].split(',').map(Number);
        const len = Math.sqrt(normal[0]**2+normal[1]**2+normal[2]**2);
        const nn = normal.map(v=>v/len);
        const d = origin[0]*nn[0]+origin[1]*nn[1]+origin[2]*nn[2];
        planes.push({ origin, normal: nn, d });
    }
    return planes;
}
const refPlanes = parseRefPlanes(refStep);

function matchesRef(ent) {
    for (const rp of refPlanes) {
        const dot = ent.normal.x*rp.normal[0]+ent.normal.y*rp.normal[1]+ent.normal.z*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.05) continue;
        const rd = dot > 0 ? rp.d : -rp.d;
        if (Math.abs(ent.d - rd) <= 1.0) return true;
    }
    return false;
}

// Group by header length
const byHeaderLen = {};
for (const e of entities) {
    const key = e.headerLength;
    if (!byHeaderLen[key]) byHeaderLen[key] = { matched: [], unmatched: [] };
    if (matchesRef(e)) byHeaderLen[key].matched.push(e);
    else byHeaderLen[key].unmatched.push(e);
}

console.log('\n=== By header length ===');
for (const [len, group] of Object.entries(byHeaderLen).sort((a,b)=>Number(a[0])-Number(b[0]))) {
    console.log(`  headerLen=${len}: ${group.matched.length} matched, ${group.unmatched.length} unmatched`);
}

// Look at specific bytes in the header that differ between matched and unmatched
// Focus on the most common header length
const commonLen = Object.entries(byHeaderLen)
    .sort((a,b) => (b[1].matched.length+b[1].unmatched.length) - (a[1].matched.length+a[1].unmatched.length))[0];
console.log(`\nMost common header length: ${commonLen[0]} bytes (${commonLen[1].matched.length}+${commonLen[1].unmatched.length})`);

// For each byte position, count values in matched vs unmatched
const hLen = Number(commonLen[0]);
if (hLen > 0 && hLen < 100) {
    const allInGroup = [...commonLen[1].matched, ...commonLen[1].unmatched];
    console.log(`\nByte-by-byte analysis for headerLen=${hLen}:`);
    
    // Show first 5 matched and 5 unmatched headers
    console.log('\nFirst 5 MATCHED headers:');
    for (const e of commonLen[1].matched.slice(0, 5)) {
        console.log(`  id=${e.id} d=${e.d.toFixed(1)} n=(${e.normal.x.toFixed(3)},${e.normal.y.toFixed(3)},${e.normal.z.toFixed(3)}) header: ${e.headerHex}`);
    }
    console.log('\nFirst 5 UNMATCHED headers:');
    for (const e of commonLen[1].unmatched.slice(0, 5)) {
        console.log(`  id=${e.id} d=${e.d.toFixed(1)} n=(${e.normal.x.toFixed(3)},${e.normal.y.toFixed(3)},${e.normal.z.toFixed(3)}) header: ${e.headerHex}`);
    }
    
    // Find bytes that differ significantly between matched and unmatched
    console.log('\nByte positions with significant differences:');
    for (let pos = 0; pos < hLen; pos++) {
        const mVals = new Set(commonLen[1].matched.map(e => e.headerBytes[pos]));
        const uVals = new Set(commonLen[1].unmatched.map(e => e.headerBytes[pos]));
        
        // Check if this byte has different ranges for matched vs unmatched
        const mArr = commonLen[1].matched.map(e => e.headerBytes[pos]);
        const uArr = commonLen[1].unmatched.map(e => e.headerBytes[pos]);
        const mMin = Math.min(...mArr), mMax = Math.max(...mArr);
        const uMin = Math.min(...uArr), uMax = Math.max(...uArr);
        
        // Find values unique to matched or unmatched
        const mOnly = [...mVals].filter(v => !uVals.has(v));
        const uOnly = [...uVals].filter(v => !mVals.has(v));
        
        if (mOnly.length > 0 || uOnly.length > 0) {
            console.log(`  byte[${pos}]: matched=[${mMin}-${mMax}] (${[...mVals].sort((a,b)=>a-b).slice(0,8).map(v=>'0x'+v.toString(16)).join(',')}), unmatched=[${uMin}-${uMax}] (${[...uVals].sort((a,b)=>a-b).slice(0,8).map(v=>'0x'+v.toString(16)).join(',')})`);
        }
    }
}

// Also try: look at the parent block's primary entity type
// Perhaps planes are sub-records of face entities (0x0F) and lines are sub-records of edge entities (0x10)?
console.log('\n=== Parent block primary entity type ===');
const entsByParent = {};
for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + SENTINEL.length;
    const blockEnd = i + 1 < sents.length ? sents[i + 1] : data.length;
    const block = data.subarray(blockStart, blockEnd);
    
    // Primary entity type
    if (block.length < 8 || block.readUInt32BE(0) !== 3) continue;
    const primaryType = block[5];
    
    // Find type-0x1E sub-records in this block
    const subRecords = [];
    let searchStart = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
        if (sepIdx < 0) { subRecords.push(block.subarray(searchStart)); break; }
        subRecords.push(block.subarray(searchStart, sepIdx));
        searchStart = sepIdx + SUB_RECORD_SEP.length;
    }
    
    for (let si = 1; si < subRecords.length; si++) {
        const rec = subRecords[si];
        if (rec.length < 4 || rec[0] !== 0x00 || rec[1] !== 0x1e) continue;
        const id = rec.readUInt16BE(2);
        const ent = entities.find(e => e.id === id);
        if (ent) {
            const key = `0x${primaryType.toString(16).padStart(2,'0')}`;
            if (!entsByParent[key]) entsByParent[key] = { matched: 0, unmatched: 0 };
            if (matchesRef(ent)) entsByParent[key].matched++;
            else entsByParent[key].unmatched++;
        }
    }
}

for (const [parent, counts] of Object.entries(entsByParent).sort((a,b)=>a[0].localeCompare(b[0]))) {
    console.log(`  parent ${parent}: ${counts.matched} matched, ${counts.unmatched} unmatched`);
}
