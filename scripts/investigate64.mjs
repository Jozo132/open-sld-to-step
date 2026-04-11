#!/usr/bin/env node
/**
 * investigate64.mjs — How many vertices does each reference plane actually have?
 * Are our wrong inferred planes getting too few?
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
const model = parser.parse();
const verts = model.vertices;

// For each model plane, count associated vertices and 2D area
const planeFaces = model.surfaces.filter(s => s.surfaceType === 'plane');
console.log('=== Model planes: vertex count and 2D spread ===');
console.log('(Planes that MATCH reference marked with ✓, unmatched with ✗)');

// Load reference for matching
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

function matchesRef(mp) {
    const n = mp.params.normal;
    const o = mp.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    for (const rp of refUnique) {
        const dot = n.x*rp.normal[0]+n.y*rp.normal[1]+n.z*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.05) continue;
        const rd = dot > 0 ? rp.d : -rp.d;
        if (Math.abs(d - rd) <= 1.0) return true;
    }
    return false;
}

// Count vertices per plane
const matchedPlanes = { vertCounts: [], areas: [] };
const unmatchedPlanes = { vertCounts: [], areas: [] };

for (const surf of planeFaces) {
    const n = surf.params.normal;
    const o = surf.params.origin;
    let count = 0;
    for (const v of verts) {
        const dx = v.position.x - o.x, dy = v.position.y - o.y, dz = v.position.z - o.z;
        if (Math.abs(dx*n.x + dy*n.y + dz*n.z) < 0.5) count++;
    }
    
    const matched = matchesRef(surf);
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    const status = matched ? '✓' : '✗';
    const bucket = matched ? matchedPlanes : unmatchedPlanes;
    bucket.vertCounts.push(count);
}

matchedPlanes.vertCounts.sort((a,b) => a-b);
unmatchedPlanes.vertCounts.sort((a,b) => a-b);

console.log(`\nMatched planes (${matchedPlanes.vertCounts.length}): vertex counts`);
console.log(`  min=${matchedPlanes.vertCounts[0]} median=${matchedPlanes.vertCounts[Math.floor(matchedPlanes.vertCounts.length/2)]} max=${matchedPlanes.vertCounts[matchedPlanes.vertCounts.length-1]}`);
console.log(`  distribution: ${matchedPlanes.vertCounts.join(', ')}`);

console.log(`\nUnmatched planes (${unmatchedPlanes.vertCounts.length}): vertex counts`);
console.log(`  min=${unmatchedPlanes.vertCounts[0]} median=${unmatchedPlanes.vertCounts[Math.floor(unmatchedPlanes.vertCounts.length/2)]} max=${unmatchedPlanes.vertCounts[unmatchedPlanes.vertCounts.length-1]}`);
console.log(`  distribution: ${unmatchedPlanes.vertCounts.join(', ')}`);

// What threshold would separate matched from unmatched?
for (const threshold of [3, 4, 5, 6, 8, 10, 15]) {
    const keptMatched = matchedPlanes.vertCounts.filter(c => c >= threshold).length;
    const keptUnmatched = unmatchedPlanes.vertCounts.filter(c => c >= threshold).length;
    const killedMatched = matchedPlanes.vertCounts.filter(c => c < threshold).length;
    const killedUnmatched = unmatchedPlanes.vertCounts.filter(c => c < threshold).length;
    console.log(`  threshold=${threshold}: keep ${keptMatched}✓+${keptUnmatched}✗  kill ${killedMatched}✓+${killedUnmatched}✗`);
}
