#!/usr/bin/env node
/**
 * investigate74.mjs — Find where cone data is hiding in Parasolid binary
 * Clean-room analysis of public-domain NIST test files.
 *
 * Strategy:
 * 1. Parse reference STEP to get CONICAL_SURFACE semiAngles and radii
 * 2. Search the raw Parasolid binary for those float64 BE values
 * 3. Check if any 0x1F entities have near-zero but non-zero semiAngle
 * 4. Examine entity types we haven't considered
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const REF_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

function parseStepEntities(text) {
    const entities = new Map();
    const dataStart = text.indexOf('DATA;');
    const dataEnd = text.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;
    const data = text.slice(dataStart + 5, dataEnd).replace(/\r\n/g, '\n');
    const joined = data.replace(/\n(?!#\d+=)/g, '');
    const reLine = /^#(\d+)\s*=\s*(.+);$/gm;
    let m;
    while ((m = reLine.exec(joined)) !== null) {
        const id = parseInt(m[1], 10);
        const rest = m[2].trim();
        const typeMatch = rest.match(/^(\w+)\s*\((.+)\)$/s);
        if (typeMatch) {
            entities.set(id, { type: typeMatch[1], args: typeMatch[2] });
        }
    }
    return entities;
}

function parseFloatList(s) {
    return s.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));
}

function extractRefCones(entities) {
    const cones = [];
    for (const [id, ent] of entities) {
        if (ent.type !== 'CONICAL_SURFACE') continue;
        // CONICAL_SURFACE('',#axis,radius,semiAngle)
        const match = ent.args.match(/,\s*#(\d+)\s*,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)/);
        if (!match) continue;
        const axisId = parseInt(match[1], 10);
        const radius = parseFloat(match[2]);
        const semiAngle = parseFloat(match[3]); // degrees in STEP
        cones.push({ id, axisId, radius, semiAngle });
    }
    return cones;
}

function extractRefCylinders(entities) {
    const cyls = [];
    for (const [id, ent] of entities) {
        if (ent.type !== 'CYLINDRICAL_SURFACE') continue;
        const match = ent.args.match(/,\s*#(\d+)\s*,\s*([\d.eE+-]+)/);
        if (!match) continue;
        const axisId = parseInt(match[1], 10);
        const radius = parseFloat(match[2]);
        cyls.push({ id, axisId, radius });
    }
    return cyls;
}

function float64BEBuffer(val) {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(val);
    return buf;
}

function searchFloat64InBuffer(haystack, targetVal, tolerance = 1e-10) {
    const positions = [];
    for (let off = 0; off + 8 <= haystack.length; off++) {
        const val = haystack.readDoubleBE(off);
        if (isFinite(val) && Math.abs(val - targetVal) < tolerance) {
            positions.push({ offset: off, value: val });
        }
    }
    return positions;
}

function extractEntities(buf) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = buf.indexOf(SENTINEL, idx)) >= 0) {
        sentPositions.push(idx);
        idx += SENTINEL.length;
    }
    const entities = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + SENTINEL.length;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : buf.length;
        const block = buf.subarray(blockStart, blockEnd);
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
            if (si === 0) {
                if (rec.length < 8 || rec.readUInt32BE(0) !== 3) continue;
                entities.push({ type: rec[5], id: rec.readUInt16BE(6), data: rec.subarray(8), blockIdx: i, subIdx: si });
            } else {
                if (rec.length < 4 || rec[0] !== 0x00) continue;
                entities.push({ type: rec[1], id: rec.readUInt16BE(2), data: rec.subarray(4), blockIdx: i, subIdx: si });
            }
        }
    }
    return entities;
}

// ── Focus on CTC_02 (158 cones) ──

const sldprtPath = path.join(NIST_DIR, 'nist_ctc_02_asme1_rc_sw1802.SLDPRT');
const refPath = path.join(REF_DIR, 'nist_ctc_02_asme1_rc.stp');

const sldprt = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(sldprt);
const psBuf = result.data;

console.log(`Parasolid buffer size: ${psBuf.length} bytes`);

const refText = fs.readFileSync(refPath, 'utf-8');
const refEntities = parseStepEntities(refText);
const refCones = extractRefCones(refEntities);
const refCyls = extractRefCylinders(refEntities);

console.log(`\nReference: ${refCones.length} cones, ${refCyls.length} cylinders`);

// ── Step 1: Print unique cone parameters ──
const uniqueAngles = new Set();
const uniqueRadii = new Set();
for (const c of refCones) {
    uniqueAngles.add(c.semiAngle.toFixed(6));
    uniqueRadii.add(c.radius.toFixed(4));
}
console.log(`\nUnique cone semiAngles (degrees): ${[...uniqueAngles].sort().join(', ')}`);
console.log(`Unique cone radii (mm): ${[...uniqueRadii].sort((a,b) => a-b).join(', ')}`);

// ── Step 2: Convert cone semiAngle to radians (Parasolid uses radians) ──
const anglesRad = [...uniqueAngles].map(a => parseFloat(a) * Math.PI / 180);
console.log(`\nSemiAngles in radians: ${anglesRad.map(a => a.toFixed(8)).join(', ')}`);

// ── Step 3: Search for semiAngle values as float64 BE in binary ──
console.log(`\n═══ Searching Parasolid binary for cone semiAngle float64 values ═══`);
for (const angleRad of anglesRad) {
    const positions = searchFloat64InBuffer(psBuf, angleRad, 1e-6);
    console.log(`  angle=${(angleRad*180/Math.PI).toFixed(2)}° (${angleRad.toFixed(8)} rad): ${positions.length} occurrences`);
    if (positions.length > 0 && positions.length <= 10) {
        for (const pos of positions) {
            // Show context: what entity type is near this position?
            const nearestSent = findNearestSentinel(psBuf, pos.offset);
            console.log(`    offset=${pos.offset} (0x${pos.offset.toString(16)}), nearest sentinel: ${nearestSent}`);
        }
    }
}

// Also search for cone radii converted to meters (PS stores in meters)
console.log(`\n═══ Searching for cone radii (in meters, PS units) ═══`);
for (const radiusMM of [...uniqueRadii].map(r => parseFloat(r))) {
    const radiusM = radiusMM / 1000.0;
    const positions = searchFloat64InBuffer(psBuf, radiusM, 1e-8);
    console.log(`  r=${radiusMM}mm (${radiusM}m): ${positions.length} occurrences`);
}

function findNearestSentinel(buf, offset) {
    let best = -1;
    let idx = 0;
    while ((idx = buf.indexOf(SENTINEL, idx)) >= 0) {
        if (idx <= offset) best = idx;
        else break;
        idx += SENTINEL.length;
    }
    if (best < 0) return 'none';
    return `@${best} (delta=${offset - best})`;
}

// ── Step 4: Check ALL 0x1F entity semiAngle values (not just threshold) ──
console.log(`\n═══ All 0x1F entity float[10] values (semiAngle position) ═══`);
const ents = extractEntities(psBuf);
const ents1F = ents.filter(e => e.type === 0x1f);
const semiAngles = [];
for (const ent of ents1F) {
    for (const marker of [0x2b, 0x2d]) {
        const markerIdx = ent.data.indexOf(marker);
        if (markerIdx < 0) continue;
        const floats = [];
        for (let off = markerIdx + 1; off + 8 <= ent.data.length; off += 8) {
            const val = ent.data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }
        if (floats.length >= 11) {
            semiAngles.push(floats[10]);
        }
    }
}
// Histogram of semiAngle values
const bins = {};
for (const a of semiAngles) {
    const key = Math.abs(a) < 1e-12 ? '0' : a.toExponential(2);
    bins[key] = (bins[key] || 0) + 1;
}
console.log(`Total 0x1F entities with ≥11 floats: ${semiAngles.length}`);
console.log(`SemiAngle distribution: ${JSON.stringify(bins, null, 2)}`);

// ── Step 5: Check ALL entity types (not just 0x1E/0x1F) ──
console.log(`\n═══ Entity type distribution ═══`);
const typeHist = {};
for (const e of ents) {
    const key = `0x${e.type.toString(16).padStart(2, '0')}`;
    typeHist[key] = (typeHist[key] || 0) + 1;
}
console.log(JSON.stringify(typeHist, null, 2));

// ── Step 6: For non-0x1E/0x1F entity types, check if they contain float64 values ──
console.log(`\n═══ Checking other entity types for geometry data ═══`);
const otherTypes = new Set(ents.filter(e => e.type !== 0x1e && e.type !== 0x1f).map(e => e.type));
for (const t of [...otherTypes].sort()) {
    const typeEnts = ents.filter(e => e.type === t);
    let hasMarker = 0;
    let avgLen = 0;
    for (const e of typeEnts) {
        avgLen += e.data.length;
        if (e.data.indexOf(0x2b) >= 0 || e.data.indexOf(0x2d) >= 0) hasMarker++;
    }
    avgLen = Math.round(avgLen / typeEnts.length);
    console.log(`  type=0x${t.toString(16).padStart(2,'0')}: ${typeEnts.length} entities, avgLen=${avgLen}, withMarker=${hasMarker}`);
}

// ── Step 7: For the ONE cone we found (CTC_02 entity 4491), show full hex dump ──
const coneEnt = ents.find(e => e.id === 4491 && e.type === 0x1e);
if (coneEnt) {
    console.log(`\n═══ Single found cone (0x1E id=4491) hex dump ═══`);
    console.log(`  data length: ${coneEnt.data.length}`);
    console.log(`  hex: ${coneEnt.data.toString('hex')}`);
    // Print all floats
    for (const marker of [0x2b, 0x2d]) {
        const idx = coneEnt.data.indexOf(marker);
        if (idx < 0) continue;
        console.log(`  marker 0x${marker.toString(16)} at offset ${idx}`);
        for (let off = idx + 1, fi = 0; off + 8 <= coneEnt.data.length; off += 8, fi++) {
            const val = coneEnt.data.readDoubleBE(off);
            console.log(`    float[${fi}] = ${val} (${val * 1000} mm)`);
        }
    }
}
