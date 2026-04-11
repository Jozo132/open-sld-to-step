#!/usr/bin/env node
/**
 * investigate59.mjs — Deep diagnosis of BRep extraction problems
 * Clean-room analysis of public-domain NIST test files.
 *
 * 1. What is the vertex position range?
 * 2. How many extracted vs inferred planes?
 * 3. Which planes have bogus normals?
 * 4. Why are angular-sorted boundaries creating zigzag?
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

// Step 1: vertex range
const PS_TO_MM = 1000;
const coords = parser.extractCoordinates();
const verts = coords.map(c => ({ x: c.x*PS_TO_MM, y: c.y*PS_TO_MM, z: c.z*PS_TO_MM }));
console.log(`Total vertices: ${verts.length}`);
const xs = verts.map(v=>v.x), ys = verts.map(v=>v.y), zs = verts.map(v=>v.z);
console.log(`X: [${Math.min(...xs).toFixed(1)}, ${Math.max(...xs).toFixed(1)}]`);
console.log(`Y: [${Math.min(...ys).toFixed(1)}, ${Math.max(...ys).toFixed(1)}]`);
console.log(`Z: [${Math.min(...zs).toFixed(1)}, ${Math.max(...zs).toFixed(1)}]`);

// Step 2: Check specific z values
const z100 = verts.filter(v => Math.abs(v.z - (-100)) < 0.5);
const z0 = verts.filter(v => Math.abs(v.z - 0) < 0.5);
const z50 = verts.filter(v => Math.abs(v.z - 50) < 0.5);
console.log(`\nVertices near z=-100: ${z100.length}`);
console.log(`Vertices near z=0: ${z0.length}`);
console.log(`Vertices near z=50: ${z50.length}`);

// Step 3: All unique z-values (clustered)
const zVals = [...new Set(zs.map(z => Math.round(z * 10) / 10))].sort((a,b) => a-b);
console.log(`\nUnique z-values (rounded to 0.1mm): ${zVals.length}`);
for (const z of zVals) {
    const count = verts.filter(v => Math.abs(v.z - z) < 0.05).length;
    if (count >= 2) console.log(`  z=${z.toFixed(1)}: ${count} verts`);
}

// Step 4: Parse full model and analyze surfaces
const model = parser.parse();
console.log(`\n=== Model Summary ===`);
console.log(`Surfaces: ${model.surfaces.length} (planes: ${model.surfaces.filter(s=>s.surfaceType==='plane').length}, cylinders: ${model.surfaces.filter(s=>s.surfaceType==='cylinder').length}, cones: ${model.surfaces.filter(s=>s.surfaceType==='cone').length})`);
console.log(`Faces: ${model.faces.length}`);
console.log(`Vertices: ${model.vertices.length}`);

// Step 5: For each face, show boundary vertex count and centroid
console.log(`\n=== Face boundary analysis ===`);
const planeFaces = model.faces.filter(f => {
    const s = model.surfaces.find(s => s.id === f.surface);
    return s && s.surfaceType === 'plane';
});
console.log(`Plane faces: ${planeFaces.length}`);

// Show faces with most edges (likely the ones with zigzag boundaries)
for (const face of planeFaces.slice(0, 10)) {
    const surf = model.surfaces.find(s => s.id === face.surface);
    const loop = model.loops.find(l => l.id === face.outerLoop);
    const edgeCount = loop?.edges.length || 0;
    const n = surf.params.normal;
    console.log(`  Face ${face.id}: surf ${surf.surfaceType} n=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) edges=${edgeCount} innerLoops=${face.innerLoops.length}`);
}

// Step 6: Show faces sorted by edge count (most complex first)
console.log(`\n=== 10 most complex face boundaries ===`);
const allFaceInfo = model.faces.map(f => {
    const surf = model.surfaces.find(s => s.id === f.surface);
    const loop = model.loops.find(l => l.id === f.outerLoop);
    return { face: f, surf, edges: loop?.edges.length || 0 };
}).sort((a, b) => b.edges - a.edges);

for (const { face, surf, edges } of allFaceInfo.slice(0, 10)) {
    console.log(`  Face ${face.id}: ${surf.surfaceType} edges=${edges} innerLoops=${face.innerLoops.length}`);
}

// Step 7: Compare — reference plane edges per face
const refStep = fs.readFileSync('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_01_asme1_rd.stp', 'utf8');
// Count edges per ADVANCED_FACE in reference
const faceRegex = /ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)/g;
let refMatch;
const refEdgeCounts = [];
while ((refMatch = faceRegex.exec(refStep)) !== null) {
    const bounds = refMatch[1].split(',').map(s => s.trim()).filter(s => s.startsWith('#'));
    // For each bound, count its edges
    let totalEdges = 0;
    for (const bref of bounds) {
        const bid = bref.replace('#', '');
        const boundRe = new RegExp(`#${bid}\\s*=\\s*(?:FACE_OUTER_BOUND|FACE_BOUND)\\s*\\(\\s*'[^']*'\\s*,\\s*#(\\d+)`);
        const bm = refStep.match(boundRe);
        if (bm) {
            const loopId = bm[1];
            const loopRe = new RegExp(`#${loopId}\\s*=\\s*EDGE_LOOP\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
            const lm = refStep.match(loopRe);
            if (lm) {
                const edgeRefs = lm[1].split(',').filter(s => s.trim().startsWith('#'));
                totalEdges += edgeRefs.length;
            }
        }
    }
    refEdgeCounts.push(totalEdges);
}
refEdgeCounts.sort((a, b) => b - a);
console.log(`\n=== Reference face edge counts (top 10) ===`);
for (const ec of refEdgeCounts.slice(0, 10)) {
    console.log(`  ${ec} edges`);
}
const refAvg = refEdgeCounts.reduce((s,c) => s+c, 0) / refEdgeCounts.length;
console.log(`Reference avg edges/face: ${refAvg.toFixed(1)}`);

const ourEdgeCounts = allFaceInfo.map(f => f.edges).sort((a, b) => b - a);
const ourAvg = ourEdgeCounts.reduce((s,c) => s+c, 0) / ourEdgeCounts.length;
console.log(`Our avg edges/face: ${ourAvg.toFixed(1)}`);
