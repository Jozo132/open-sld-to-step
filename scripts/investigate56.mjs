#!/usr/bin/env node
/**
 * investigate56.mjs — Cone entity extraction deep dive
 * Find where cones are actually encoded in the binary.
 * Check type 0x1E entities with 11 floats for cone-like geometry.
 * NIST test files are US Government works (public domain).
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const PS_TO_MM = 1000;

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');

function extractEntities(psBuf) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx += 6; }
    
    const entities = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + 6;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : psBuf.length;
        const block = psBuf.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        const subRecords = [];
        let searchStart = 0;
        while (true) {
            const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
            if (sepIdx < 0) { subRecords.push(block.subarray(searchStart)); break; }
            subRecords.push(block.subarray(searchStart, sepIdx));
            searchStart = sepIdx + 6;
        }

        for (let si = 0; si < subRecords.length; si++) {
            const rec = subRecords[si];
            if (si === 0) {
                if (rec.length < 8 || rec.readUInt32BE(0) !== 3) continue;
                const type = rec[5]; if (type < 0x0d || type > 0x3f) continue;
                entities.push({ type, id: rec.readUInt16BE(6), data: rec.subarray(8) });
            } else {
                if (rec.length < 4 || rec[0] !== 0x00) continue;
                const type = rec[1]; if (type < 0x0d || type > 0x3f) continue;
                entities.push({ type, id: rec.readUInt16BE(2), data: rec.subarray(4) });
            }
        }
    }
    return entities;
}

function readGeomFloats(data) {
    for (const marker of [0x2b, 0x2d]) {
        const mIdx = data.indexOf(marker);
        if (mIdx < 0) continue;
        const start = mIdx + 1;
        const maxFloats = Math.floor((data.length - start) / 8);
        const floats = [];
        for (let i = 0; i < maxFloats; i++) {
            const v = data.readDoubleBE(start + i * 8);
            if (!isFinite(v) || Math.abs(v) > 1e6) break;
            floats.push(v);
        }
        if (floats.length >= 7) return { floats, marker };
    }
    return null;
}

// Analyze CTC_02 which should have 158 reference cones
const sldprtPath = path.join(NIST_DIR, 'nist_ctc_02_asme1_rc_sw1802.SLDPRT');
const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const psBuf = result.data;
const allEntities = extractEntities(psBuf);

const type1E = allEntities.filter(e => e.type === 0x1e);
const type1F = allEntities.filter(e => e.type === 0x1f);

console.log(`Type 0x1E (SURF/CURVE): ${type1E.length}`);
console.log(`Type 0x1F (BSPLINE): ${type1F.length}`);

// Analyze all type-0x1E entities with 11 floats
console.log('\n=== Type-0x1E entities with 11 floats ===');
let count11f = 0;
const conelike = [];
for (const ent of type1E) {
    const g = readGeomFloats(ent.data);
    if (!g || g.floats.length < 11) continue;
    if (g.floats.length > 11) continue; // skip B-spline-like
    count11f++;
    
    const f = g.floats;
    const semiAngle = f[10];
    const radius = f[9] * PS_TO_MM;
    const origin = { x: f[0] * PS_TO_MM, y: f[1] * PS_TO_MM, z: f[2] * PS_TO_MM };
    const axis = { x: f[3], y: f[4], z: f[5] };
    
    if (Math.abs(semiAngle) >= 1e-6) {
        conelike.push({ id: ent.id, origin, axis, radius, semiAngle, marker: g.marker });
    }
}
console.log(`Total 11-float type-0x1E: ${count11f}`);
console.log(`Cone-like (semiAngle != 0): ${conelike.length}`);
for (const c of conelike.slice(0, 20)) {
    console.log(`  id=${c.id} r=${c.radius.toFixed(2)} ha=${c.semiAngle.toFixed(4)} (${(c.semiAngle * 180 / Math.PI).toFixed(1)}°) marker=0x${c.marker.toString(16)} origin=(${c.origin.x.toFixed(1)},${c.origin.y.toFixed(1)},${c.origin.z.toFixed(1)})`);
}

// Analyze type-0x1F entities
console.log('\n=== Type-0x1F entities with 11 floats ===');
let count1F_11 = 0;
const conelike1F = [];
for (const ent of type1F) {
    const g = readGeomFloats(ent.data);
    if (!g || g.floats.length < 11) continue;
    if (g.floats.length > 11) continue;
    count1F_11++;
    
    const f = g.floats;
    const semiAngle = f[10];
    const radius = f[9] * PS_TO_MM;
    
    if (Math.abs(semiAngle) >= 1e-6) {
        conelike1F.push({ id: ent.id, radius, semiAngle });
    }
}
console.log(`Total 11-float type-0x1F: ${count1F_11}`);
console.log(`Cone-like: ${conelike1F.length}`);
for (const c of conelike1F.slice(0, 10)) {
    console.log(`  id=${c.id} r=${c.radius.toFixed(2)} ha=${c.semiAngle.toFixed(4)} (${(c.semiAngle * 180 / Math.PI).toFixed(1)}°)`);
}

// Check ALL type-0x1E float counts
console.log('\n=== Type-0x1E float count distribution ===');
const floatCounts = {};
for (const ent of type1E) {
    const g = readGeomFloats(ent.data);
    if (!g) { floatCounts['no-marker'] = (floatCounts['no-marker'] || 0) + 1; continue; }
    const k = `${g.floats.length}f`;
    floatCounts[k] = (floatCounts[k] || 0) + 1;
}
Object.entries(floatCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

// Same for type-0x1F
console.log('\n=== Type-0x1F float count distribution ===');
const floatCounts1F = {};
for (const ent of type1F) {
    const g = readGeomFloats(ent.data);
    if (!g) { floatCounts1F['no-marker'] = (floatCounts1F['no-marker'] || 0) + 1; continue; }
    const k = `${g.floats.length}f`;
    floatCounts1F[k] = (floatCounts1F[k] || 0) + 1;
}
Object.entries(floatCounts1F).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
