/**
 * investigate36.mjs — Cross-reference our STEP output with the NIST reference STEP
 *
 * Diagnose why our output looks like scattered unbounded surfaces.
 * All observations derived from publicly available NIST MBE PMI test files
 * (U.S. Government works, public domain).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ourPath = path.join(ROOT, 'output', 'nist_ctc_01_asme1_rd_sw1802.stp');
const refPath = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions', 'nist_ctc_01_asme1_rd.stp');

const ourStep = fs.readFileSync(ourPath, 'utf-8');
const refStep = fs.readFileSync(refPath, 'utf-8');

function countEntity(text, name) {
    const re = new RegExp(name.replace(/[()]/g, '\\$&'), 'g');
    return (text.match(re) || []).length;
}

const entities = [
    'CARTESIAN_POINT', 'VERTEX_POINT', 'DIRECTION', 'AXIS2_PLACEMENT_3D',
    'PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'SPHERICAL_SURFACE',
    'TOROIDAL_SURFACE', 'B_SPLINE_SURFACE',
    'LINE', 'CIRCLE', 'B_SPLINE_CURVE',
    'EDGE_CURVE', 'ORIENTED_EDGE', 'EDGE_LOOP',
    'FACE_OUTER_BOUND', 'FACE_BOUND',
    'ADVANCED_FACE',
    'OPEN_SHELL', 'CLOSED_SHELL',
    'MANIFOLD_SOLID_BREP',
    'ADVANCED_BREP_SHAPE_REPRESENTATION', 'SHAPE_REPRESENTATION',
];

console.log('Entity comparison:');
console.log(`${'Entity'.padEnd(40)} ${'Ours'.padStart(6)} ${'Ref'.padStart(6)}`);
console.log('-'.repeat(54));
for (const e of entities) {
    const ours = countEntity(ourStep, e);
    const ref = countEntity(refStep, e);
    if (ours > 0 || ref > 0) {
        const flag = ours !== ref ? ' <<<' : '';
        console.log(`${e.padEnd(40)} ${String(ours).padStart(6)} ${String(ref).padStart(6)}${flag}`);
    }
}

// Check reference for surface types used in ADVANCED_FACE
console.log('\n--- Reference ADVANCED_FACE details (first 10) ---');
const refLines = refStep.split('\n');
const refEntMap = new Map();
for (const line of refLines) {
    const m = line.match(/^#(\d+)=(.+);$/);
    if (m) refEntMap.set(parseInt(m[1]), m[2]);
}

let faceCount = 0;
const faceSurfTypes = {};
for (const [id, val] of refEntMap) {
    if (!val.startsWith('ADVANCED_FACE')) continue;
    faceCount++;
    // ADVANCED_FACE('',(...bounds...),#surfRef,.T.)
    const surfRefMatch = val.match(/,#(\d+),\.[TF]\./);
    if (surfRefMatch) {
        const surfId = parseInt(surfRefMatch[1]);
        const surfDef = refEntMap.get(surfId);
        if (surfDef) {
            const surfType = surfDef.split('(')[0];
            faceSurfTypes[surfType] = (faceSurfTypes[surfType] || 0) + 1;
        }
    }
}
console.log(`Total ADVANCED_FACE: ${faceCount}`);
console.log('Surface types used by faces:', faceSurfTypes);

// Check our edge loops
console.log('\n--- Our EDGE_LOOP details ---');
const ourEdgeLoops = (ourStep.match(/EDGE_LOOP\([^)]*\)/g) || []);
const emptyLoops = ourEdgeLoops.filter(l => l.includes('()'));
console.log(`Total edge loops: ${ourEdgeLoops.length}, empty: ${emptyLoops.length}`);

// Check ref edge loops
const refEdgeLoops = (refStep.match(/EDGE_LOOP\([^)]*\)/g) || []);
const refEmptyLoops = refEdgeLoops.filter(l => l.includes('()'));
console.log(`Ref edge loops: ${refEdgeLoops.length}, empty: ${refEmptyLoops.length}`);

// Analyze reference: how many edges per face?
console.log('\n--- Reference edges per loop ---');
const edgesPerLoop = [];
for (const loop of refEdgeLoops) {
    const refs = (loop.match(/#\d+/g) || []);
    edgesPerLoop.push(refs.length);
}
const avgEdges = edgesPerLoop.reduce((a, b) => a + b, 0) / edgesPerLoop.length;
console.log(`Avg edges/loop: ${avgEdges.toFixed(1)}, min: ${Math.min(...edgesPerLoop)}, max: ${Math.max(...edgesPerLoop)}`);

// Check our cylinder radii vs ref
console.log('\n--- Cylinder radius comparison ---');
const ourCyls = [];
for (const m of ourStep.matchAll(/CYLINDRICAL_SURFACE\('',#\d+,([\d.eE+-]+)\)/g)) {
    ourCyls.push(parseFloat(m[1]));
}
const refCyls = [];
for (const m of refStep.matchAll(/CYLINDRICAL_SURFACE\('',#\d+,([\d.eE+-]+)\)/g)) {
    refCyls.push(parseFloat(m[1]));
}
console.log(`Our cylinders: ${ourCyls.length}, Ref cylinders: ${refCyls.length}`);

const ourUniqueRad = [...new Set(ourCyls.map(r => r.toFixed(4)))].sort();
const refUniqueRad = [...new Set(refCyls.map(r => r.toFixed(4)))].sort();
console.log(`Our unique radii: ${ourUniqueRad.join(', ')}`);
console.log(`Ref unique radii: ${refUniqueRad.join(', ')}`);

// Check our plane count vs ref (7-float entities include LINEs!)
console.log('\n--- Plane comparison ---');
const ourPlanes = countEntity(ourStep, 'PLANE');
const refPlanes = countEntity(refStep, 'PLANE');
console.log(`Our PLANEs: ${ourPlanes}, Ref PLANEs: ${refPlanes}`);

// Check reference: any B-spline surfaces?
const refBSplineSurf = countEntity(refStep, 'B_SPLINE_SURFACE_WITH_KNOTS');
console.log(`Ref B_SPLINE_SURFACE_WITH_KNOTS: ${refBSplineSurf}`);

// File sizes
console.log(`\nOur file: ${(ourStep.length / 1024).toFixed(1)} KB`);
console.log(`Ref file: ${(refStep.length / 1024).toFixed(1)} KB`);
