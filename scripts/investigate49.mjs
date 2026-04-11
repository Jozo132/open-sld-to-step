/**
 * investigate49.mjs — Full face dump: which plane equations have faces?
 * And what do the hulls look like?
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const buf = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const result = SldprtContainerParser.extractParasolid(buf);
const parser = new ParasolidParser(result.data);
const model = parser.parse();

console.log(`Total faces: ${model.faces.length}`);
console.log(`Total surfaces: ${model.surfaces.length}`);

const planes = model.surfaces.filter(s => s.surfaceType === 'plane');
const cyls = model.surfaces.filter(s => s.surfaceType === 'cylinder');

// For each face, show the surface it references
console.log('\n=== PLANE FACES ===');
let planeFaceCount = 0;
for (const face of model.faces) {
    const surf = model.surfaces.find(s => s.id === face.surface);
    if (!surf || surf.surfaceType !== 'plane') continue;
    planeFaceCount++;
    
    const n = surf.params.normal;
    const o = surf.params.origin;
    const d = n.x * o.x + n.y * o.y + n.z * o.z;
    
    // Get hull extent from outer loop
    const loop = model.loops.find(l => l.id === face.outerLoop);
    const vtxPositions = [];
    if (loop) {
        for (const eid of loop.edges) {
            const edge = model.edges.find(e => e.id === eid);
            if (!edge) continue;
            const sv = model.vertices.find(v => v.id === edge.startVertex);
            if (sv) vtxPositions.push(sv.position);
        }
    }
    
    let extent = 'N/A';
    if (vtxPositions.length > 0) {
        const xs = vtxPositions.map(p => p.x), ys = vtxPositions.map(p => p.y), zs = vtxPositions.map(p => p.z);
        extent = `X:[${Math.min(...xs).toFixed(0)},${Math.max(...xs).toFixed(0)}] Y:[${Math.min(...ys).toFixed(0)},${Math.max(...ys).toFixed(0)}] Z:[${Math.min(...zs).toFixed(0)},${Math.max(...zs).toFixed(0)}]`;
    }
    
    console.log(`  Face ${face.id}: surf=${surf.id} n=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) d=${d.toFixed(1)} innerLoops=${face.innerLoops.length} edges=${loop?.edges.length || 0} ${extent}`);
}

console.log(`\n=== CYLINDER FACES ===`);
let cylFaceCount = 0;
for (const face of model.faces) {
    const surf = model.surfaces.find(s => s.id === face.surface);
    if (!surf || surf.surfaceType !== 'cylinder') continue;
    cylFaceCount++;
}

console.log(`Plane faces: ${planeFaceCount}, Cylinder faces: ${cylFaceCount}`);

// Which planes DON'T have faces?
console.log('\n=== PLANES WITHOUT FACES ===');
for (const plane of planes) {
    const hasFace = model.faces.some(f => f.surface === plane.id);
    if (!hasFace) {
        const n = plane.params.normal;
        const o = plane.params.origin;
        console.log(`  Plane ${plane.id}: n=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) origin=(${o.x.toFixed(0)},${o.y.toFixed(0)},${o.z.toFixed(0)})`);
    }
}
