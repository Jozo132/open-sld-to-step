#!/usr/bin/env node
/**
 * investigate67.mjs — Map vertex distribution along X/Y/Z axes to find
 * actual face plane positions vs extracted plane d-values.
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

const PS_TO_MM = 1000;
const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const buf = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const result = SldprtContainerParser.extractParasolid(buf);
const parser = new ParasolidParser(result.data);
const points = parser.extractCoordinates();
const verts = points.map(p => ({
    x: p.x * PS_TO_MM,
    y: p.y * PS_TO_MM,
    z: p.z * PS_TO_MM,
}));
console.log(`Total vertices: ${verts.length}`);

// Load reference planes
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

// For each axis, find vertex clusters and compare with reference plane d-values
for (const [axisName, project] of [
    ['X', v => v.x],
    ['Y', v => v.y],
    ['Z', v => v.z],
]) {
    const projections = verts.map(project);
    projections.sort((a, b) => a - b);
    
    // Cluster projections within 0.5mm
    const clusters = [];
    let ci = 0;
    while (ci < projections.length) {
        const d0 = projections[ci];
        const start = ci;
        while (ci < projections.length && projections[ci] - d0 < 0.5) ci++;
        const count = ci - start;
        const dAvg = projections.slice(start, ci).reduce((a, b) => a + b, 0) / count;
        clusters.push({ d: dAvg, count });
    }
    
    // Reference planes along this axis (positive normal)
    const refDvals = [];
    const normal = axisName === 'X' ? [1,0,0] : axisName === 'Y' ? [0,1,0] : [0,0,1];
    for (const rp of refPlanes) {
        const dot = rp.normal[0]*normal[0] + rp.normal[1]*normal[1] + rp.normal[2]*normal[2];
        if (Math.abs(Math.abs(dot) - 1) > 0.05) continue;
        const d = dot > 0 ? rp.d : -rp.d;
        if (!refDvals.find(rd => Math.abs(rd - d) < 0.5)) refDvals.push(d);
    }
    refDvals.sort((a, b) => a - b);
    
    console.log(`\n=== ${axisName}-axis ===`);
    console.log(`Reference plane d-values: ${refDvals.map(d => d.toFixed(1)).join(', ')}`);
    console.log(`Vertex clusters (count ≥ 3):`);
    
    for (const cl of clusters.filter(c => c.count >= 3)) {
        // Check if this matches a reference plane
        const matchRef = refDvals.find(rd => Math.abs(rd - cl.d) < 1.0);
        const marker = matchRef !== undefined ? ' ✓' : '  ';
        console.log(`  ${marker} d=${cl.d.toFixed(1)}mm  count=${cl.count}${matchRef !== undefined ? ` (ref ${matchRef.toFixed(1)})` : ''}`);
    }
}

// Also look at the extracted type-0x1E entities along each axis
const parser2 = new ParasolidParser(result.data);
const proto = Object.getPrototypeOf(parser2);
const rawExtracted = proto.extractSurfaces.call(parser2);
const extractedPlanes = rawExtracted.filter(s => s.surfaceType === 'plane');

console.log(`\n=== Extracted type-0x1E plane d-values vs vertex clusters ===`);
for (const [axisName, getD, normal] of [
    ['X', s => s.params.origin.x * s.params.normal.x, [1,0,0]],
    ['Y', s => s.params.origin.y * s.params.normal.y, [0,1,0]],
    ['Z', s => s.params.origin.z * s.params.normal.z, [0,0,1]],
]) {
    const axPlanes = extractedPlanes.filter(s => {
        const n = s.params.normal;
        const dot = n.x*normal[0]+n.y*normal[1]+n.z*normal[2];
        return Math.abs(Math.abs(dot)-1) < 0.05;
    });
    if (axPlanes.length === 0) continue;
    
    // Unique d-values
    const dvals = [];
    for (const s of axPlanes) {
        const n = s.params.normal;
        const o = s.params.origin;
        const d = n.x*o.x + n.y*o.y + n.z*o.z;
        if (!dvals.find(ed => Math.abs(ed.d - d) < 0.5)) {
            dvals.push({ d, count: 1 });
        } else {
            dvals.find(ed => Math.abs(ed.d - d) < 0.5).count++;
        }
    }
    dvals.sort((a, b) => a.d - b.d);
    
    console.log(`\n${axisName}-axis extracted planes (unique d-values): ${dvals.length}`);
    const refDvals = [];
    for (const rp of refPlanes) {
        const dot = rp.normal[0]*normal[0]+rp.normal[1]*normal[1]+rp.normal[2]*normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.05) continue;
        const d = dot > 0 ? rp.d : -rp.d;
        if (!refDvals.find(rd => Math.abs(rd - d) < 0.5)) refDvals.push(d);
    }
    refDvals.sort((a, b) => a - b);
    
    for (const dv of dvals) {
        const matchRef = refDvals.find(rd => Math.abs(rd - dv.d) < 1.0);
        const marker = matchRef !== undefined ? '✓' : '✗';
        console.log(`  ${marker} d=${dv.d.toFixed(1)} (${dv.count} raw entities)${matchRef !== undefined ? ` ref=${matchRef.toFixed(1)}` : ''}`);
    }
}
