#!/usr/bin/env node
/**
 * investigate62.mjs — What type-0x1E floats are rejected vs accepted?
 * Are we misclassifying LINE curves as PLANEs?
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

// Plane faces analysis
const planeFaces = model.faces.filter(f => {
    const s = model.surfaces.find(s => s.id === f.surface);
    return s && s.surfaceType === 'plane';
});

// Check reference for z=-100 plane
const refStep = fs.readFileSync('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_01_asme1_rd.stp', 'utf8');

// Reference planes at z=-100
const refPlaneRe = /PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g;
let m;
const refPlanes = [];
while ((m = refPlaneRe.exec(refStep)) !== null) {
    const axId = m[1];
    const axRe = new RegExp(`#${axId}\\s*=\\s*AXIS2_PLACEMENT_3D\\s*\\(\\s*'[^']*'\\s*,\\s*#(\\d+)\\s*,\\s*#(\\d+)`);
    const am = refStep.match(axRe);
    if (!am) continue;
    const ptRe = new RegExp(`#${am[1]}\\s*=\\s*CARTESIAN_POINT\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
    const dirRe = new RegExp(`#${am[2]}\\s*=\\s*DIRECTION\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
    const pm = refStep.match(ptRe);
    const dm = refStep.match(dirRe);
    if (!pm || !dm) continue;
    const origin = pm[1].split(',').map(Number);
    const normal = dm[1].split(',').map(Number);
    const len = Math.sqrt(normal[0]*normal[0]+normal[1]*normal[1]+normal[2]*normal[2]);
    const nn = normal.map(v=>v/len);
    const d = origin[0]*nn[0]+origin[1]*nn[1]+origin[2]*nn[2];
    refPlanes.push({ origin, normal: nn, d });
}

// How many reference planes are at z=-100?
const refZ100 = refPlanes.filter(p => Math.abs(p.normal[2]) > 0.99 && Math.abs(Math.abs(p.d) - 100) < 1);
console.log(`Reference planes at z=-100: ${refZ100.length}`);
for (const p of refZ100) {
    console.log(`  n=(${p.normal.map(v=>v.toFixed(3)).join(',')}) d=${p.d.toFixed(2)} origin=(${p.origin.map(v=>v.toFixed(1)).join(',')})`);
}

// Our planes at z=-100
const ourZ100 = model.surfaces.filter(s => {
    if (s.surfaceType !== 'plane') return false;
    const n = s.params.normal;
    const o = s.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    return Math.abs(n.z) > 0.99 && Math.abs(Math.abs(d) - 100) < 1;
});
console.log(`\nOur planes at z=-100: ${ourZ100.length}`);
for (const s of ourZ100) {
    const n = s.params.normal;
    const o = s.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    console.log(`  n=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}) d=${d.toFixed(2)} origin=(${o.x.toFixed(1)},${o.y.toFixed(1)},${o.z.toFixed(1)})`);
}

// Reference has 3 planes at z=-100 with same equation. Are these 3 separate faces on the same plane?
// Let's check unique plane equations in our data
console.log('\n=== Our plane equation distribution (sorted by d) ===');
const ourPlanes = model.surfaces.filter(s => s.surfaceType === 'plane');
const planeEqs = ourPlanes.map(s => {
    const n = s.params.normal;
    const o = s.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    return { n: `(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)})`, d, id: s.id };
}).sort((a,b) => a.d - b.d);

// Group by unique normal + d (within 0.5mm)
const groups = [];
for (const eq of planeEqs) {
    let found = false;
    for (const g of groups) {
        if (g.n === eq.n && Math.abs(g.d - eq.d) < 0.5) {
            g.count++;
            found = true;
            break;
        }
    }
    if (!found) groups.push({ ...eq, count: 1 });
}
console.log(`Unique plane equations: ${groups.length}`);

// Show non-axis-aligned planes (likely misclassified LINEs)
console.log('\n=== Non-axis-aligned planes ===');
const nonAxis = ourPlanes.filter(s => {
    const n = s.params.normal;
    return Math.abs(n.x) < 0.99 && Math.abs(n.y) < 0.99 && Math.abs(n.z) < 0.99;
});
console.log(`Total non-axis-aligned planes: ${nonAxis.length}`);
for (const s of nonAxis) {
    const n = s.params.normal;
    const o = s.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    // How many vertices on this plane?
    let count = 0;
    for (const v of model.vertices) {
        const dx = v.position.x - o.x, dy = v.position.y - o.y, dz = v.position.z - o.z;
        if (Math.abs(dx*n.x + dy*n.y + dz*n.z) < 0.5) count++;
    }
    console.log(`  surf ${s.id}: n=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}) d=${d.toFixed(2)} verts=${count}`);
}

// Check reference non-axis-aligned planes
console.log('\n=== Reference non-axis-aligned planes ===');
const refNonAxis = refPlanes.filter(p => {
    return Math.abs(p.normal[0]) < 0.99 && Math.abs(p.normal[1]) < 0.99 && Math.abs(p.normal[2]) < 0.99;
});
console.log(`Total: ${refNonAxis.length}`);
for (const p of refNonAxis) {
    console.log(`  n=(${p.normal.map(v=>v.toFixed(3)).join(',')}) d=${p.d.toFixed(2)}`);
}
