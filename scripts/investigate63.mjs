#!/usr/bin/env node
/**
 * investigate63.mjs — Trace which planes are extracted vs inferred, and their d values.
 * For CTC_01: why are 37 of 80 planes have wrong d?
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const buf = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const result = SldprtContainerParser.extractParasolid(buf);
const parser = new ParasolidParser(result.data);

const PS_TO_MM = 1000;

// Step 1: Get raw extracted surfaces
const rawSurfaces = parser.extractSurfaces();
const rawPlanes = rawSurfaces.filter(s => s.surfaceType === 'plane');
console.log(`Raw extracted type-0x1E planes: ${rawPlanes.length}`);

// Step 2: Get vertices
const coords = parser.extractCoordinates();
const verts = coords.map(c => ({ x: c.x*PS_TO_MM, y: c.y*PS_TO_MM, z: c.z*PS_TO_MM }));
console.log(`Vertices: ${verts.length}`);

// Step 3: Deduplicate raw planes
const dedup = parser.deduplicateSurfaces(rawPlanes);
console.log(`After dedup: ${dedup.length}`);

// Step 4: What does the full parse() give us?
const model = parser.parse();
const modelPlanes = model.surfaces.filter(s => s.surfaceType === 'plane');
console.log(`Model planes (extracted + inferred + dedup): ${modelPlanes.length}`);

// Step 5: Which model planes match which reference planes?
// Load reference
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

// Deduplicate reference planes by equation
const refUnique = [];
for (const rp of refPlanes) {
    const dup = refUnique.find(up => {
        const dot = up.normal[0]*rp.normal[0]+up.normal[1]*rp.normal[1]+up.normal[2]*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.01) return false;
        const rd = dot > 0 ? rp.d : -rp.d;
        return Math.abs(up.d - rd) < 0.5;
    });
    if (!dup) refUnique.push(rp);
}
console.log(`\nReference planes: ${refPlanes.length} total, ${refUnique.length} unique equations`);

// Count our planes by source: extracted (from type-0x1E) vs inferred
// We know the model has id's — lower ids are extracted, higher are inferred
// Let's actually trace through the pipeline
console.log('\n=== Model planes that DON\'T match any reference plane (threshold 1mm) ===');
const unmatched = [];
for (const mp of modelPlanes) {
    const n = mp.params.normal;
    const o = mp.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    
    let bestDist = Infinity;
    for (const rp of refUnique) {
        const dot = n.x*rp.normal[0]+n.y*rp.normal[1]+n.z*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.05) continue;
        const rd = dot > 0 ? rp.d : -rp.d;
        const dist = Math.abs(d - rd);
        if (dist < bestDist) bestDist = dist;
    }
    
    if (bestDist > 1.0) {
        unmatched.push({ mp, d, bestDist });
    }
}

console.log(`Unmatched: ${unmatched.length} of ${modelPlanes.length}`);
for (const { mp, d, bestDist } of unmatched) {
    const n = mp.params.normal;
    const isAxisAligned = Math.abs(n.x) > 0.99 || Math.abs(n.y) > 0.99 || Math.abs(n.z) > 0.99;
    console.log(`  surf ${mp.id}: n=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}) d=${d.toFixed(2)} bestDist=${bestDist.toFixed(1)}mm ${isAxisAligned ? 'AXIS' : 'ANGLED'}`);
}

console.log('\n=== Reference planes not matched by any model plane ===');
const unmatchedRef = [];
for (const rp of refUnique) {
    let bestDist = Infinity;
    for (const mp of modelPlanes) {
        const n = mp.params.normal;
        const o = mp.params.origin;
        const d = n.x*o.x + n.y*o.y + n.z*o.z;
        const dot = n.x*rp.normal[0]+n.y*rp.normal[1]+n.z*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.05) continue;
        const rd = dot > 0 ? rp.d : -rp.d;
        const dist = Math.abs(d - rd);
        if (dist < bestDist) bestDist = dist;
    }
    if (bestDist > 1.0) {
        unmatchedRef.push({ rp, bestDist });
    }
}
console.log(`Unmatched ref: ${unmatchedRef.length} of ${refUnique.length}`);
for (const { rp, bestDist } of unmatchedRef) {
    const isAxisAligned = Math.abs(rp.normal[0]) > 0.99 || Math.abs(rp.normal[1]) > 0.99 || Math.abs(rp.normal[2]) > 0.99;
    console.log(`  n=(${rp.normal.map(v=>v.toFixed(3)).join(',')}) d=${rp.d.toFixed(2)} bestDist=${bestDist.toFixed(1)}mm ${isAxisAligned ? 'AXIS' : 'ANGLED'}`);
}
