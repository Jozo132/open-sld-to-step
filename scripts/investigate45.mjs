/**
 * investigate45.mjs — Why are we finding only 15 of 57 inner loops?
 *
 * For each cylinder, check every plane face to understand why the
 * cylinder is/isn't detected as a hole.
 *
 * NIST test files are US Government works (public domain).
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
const sldprtPath = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const parser = new ParasolidParser(result.data);
const model = parser.parse();

const planes = model.surfaces.filter(s => s.surfaceType === 'plane');
const cylinders = model.surfaces.filter(s => s.surfaceType === 'cylinder');
const faces = model.faces;

console.log(`Planes: ${planes.length}, Cylinders: ${cylinders.length}, Faces: ${faces.length}`);
console.log(`Faces with inner loops: ${faces.filter(f => f.innerLoops.length > 0).length}`);
console.log(`Total inner loops: ${faces.reduce((sum, f) => sum + f.innerLoops.length, 0)}`);

// For each cylinder, check why it's not detected as a hole
// Count how many planes each cylinder is parallel to
let detectedAsHole = 0;
let notParallel = 0;
let parallelButOutside = 0;
let parallelAndInside = 0;

for (const cyl of cylinders) {
    const cp = cyl.params;
    const axis = cp.axis;
    const cylOrigin = cp.origin;
    const radius = cp.radius;
    
    let foundAsHole = false;
    let parallelCount = 0;
    let insideCount = 0;
    
    // Check against each plane face
    for (const face of faces) {
        const surf = model.surfaces.find(s => s.id === face.surface);
        if (!surf || surf.surfaceType !== 'plane') continue;
        
        const pp = surf.params;
        const normal = pp.normal;
        
        // Check parallel
        const dot = axis.x * normal.x + axis.y * normal.y + axis.z * normal.z;
        if (Math.abs(Math.abs(dot) - 1) > 0.1) continue;
        
        parallelCount++;
        
        // Check if this cylinder is already an inner loop of this face
        if (face.innerLoops.length > 0) {
            foundAsHole = true;
        }
    }
    
    if (foundAsHole) {
        detectedAsHole++;
    } else if (parallelCount === 0) {
        notParallel++;
    } else {
        parallelButOutside++;
    }
}

console.log(`\n=== Cylinder hole detection summary ===`);
console.log(`Detected as hole in at least one face: ${detectedAsHole}`);
console.log(`Not parallel to any plane: ${notParallel}`);
console.log(`Parallel but center outside all hulls: ${parallelButOutside}`);

// Detailed analysis of cylinders that are parallel but outside
console.log(`\n=== Cylinders parallel to planes but not detected as holes ===`);
for (const cyl of cylinders) {
    const cp = cyl.params;
    const axis = cp.axis;
    const cylOrigin = cp.origin;
    const radius = cp.radius;
    
    let foundAsHole = false;
    for (const face of faces) {
        if (face.innerLoops.length > 0) {
            // Check if this cylinder was used as inner loop already
            // (crude check - just see if any inner loops exist)
        }
    }

    // Check against every plane surface
    let bestDot = 0;
    let closestPlaneDist = Infinity;
    
    for (const plane of planes) {
        const pp = plane.params;
        const normal = pp.normal;
        const dot = Math.abs(axis.x * normal.x + axis.y * normal.y + axis.z * normal.z);
        if (dot > bestDot) bestDot = dot;
        
        if (dot > 0.9) {
            // Compute distance from cylinder center to plane
            const dx = cylOrigin.x - pp.origin.x;
            const dy = cylOrigin.y - pp.origin.y;
            const dz = cylOrigin.z - pp.origin.z;
            const distToPlane = Math.abs(dx * normal.x + dy * normal.y + dz * normal.z);
            if (distToPlane < closestPlaneDist) closestPlaneDist = distToPlane;
        }
    }
    
    // Check if this cylinder was detected as a hole
    let isHole = false;
    for (const face of faces) {
        for (const il of face.innerLoops) {
            // Check loop's circle curve against this cylinder
            const loop = model.loops.find(l => l.id === il);
            if (!loop) continue;
            for (const eid of loop.edges) {
                const edge = model.edges.find(e => e.id === eid);
                if (!edge) continue;
                const curve = model.curves.find(c => c.id === edge.curve);
                if (!curve || curve.curveType !== 'circle') continue;
                const cc = curve.params;
                // Compare radius
                if (Math.abs(cc.radius - radius) < 0.1) {
                    // Compare center position
                    const dx = cc.center.x - cylOrigin.x;
                    const dy = cc.center.y - cylOrigin.y;
                    const dz = cc.center.z - cylOrigin.z;
                    if (Math.sqrt(dx*dx + dy*dy + dz*dz) < radius + 5) {
                        isHole = true;
                    }
                }
            }
        }
    }
    
    if (!isHole && bestDot > 0.9) {
        console.log(`  Cyl id=${cyl.id} r=${radius.toFixed(2)} axis=(${axis.x.toFixed(2)},${axis.y.toFixed(2)},${axis.z.toFixed(2)}) origin=(${cylOrigin.x.toFixed(1)},${cylOrigin.y.toFixed(1)},${cylOrigin.z.toFixed(1)}) bestDot=${bestDot.toFixed(3)} closestPlaneDist=${closestPlaneDist.toFixed(1)}`);
    }
}

// Also: how many faces have ≥3 vertices that could contain holes?
const facesWithEnoughVerts = [];
for (const face of faces) {
    const surf = model.surfaces.find(s => s.id === face.surface);
    if (!surf || surf.surfaceType !== 'plane') continue;
    facesWithEnoughVerts.push(face);
}
console.log(`\nPlane faces: ${facesWithEnoughVerts.length}`);
console.log(`Plane faces with inner loops: ${facesWithEnoughVerts.filter(f => f.innerLoops.length > 0).length}`);

// Show face bounding box info
for (const face of facesWithEnoughVerts) {
    const surf = model.surfaces.find(s => s.id === face.surface);
    const pp = surf.params;
    // Get hull extent from loop edges
    const loop = model.loops.find(l => l.id === face.outerLoop);
    if (!loop) continue;
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const eid of loop.edges) {
        const edge = model.edges.find(e => e.id === eid);
        if (!edge) continue;
        const sv = model.vertices.find(v => v.id === edge.startVertex);
        if (!sv) continue;
        minX = Math.min(minX, sv.position.x); maxX = Math.max(maxX, sv.position.x);
        minY = Math.min(minY, sv.position.y); maxY = Math.max(maxY, sv.position.y);
        minZ = Math.min(minZ, sv.position.z); maxZ = Math.max(maxZ, sv.position.z);
    }
    
    const n = pp.normal;
    const extent = `(${(maxX-minX).toFixed(0)} × ${(maxY-minY).toFixed(0)} × ${(maxZ-minZ).toFixed(0)})`;
    const nStr = `(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)})`;
    if (face.innerLoops.length > 0 || (maxX-minX) > 100 || (maxY-minY) > 100 || (maxZ-minZ) > 100) {
        console.log(`  Face id=${face.id} n=${nStr} extent=${extent} holes=${face.innerLoops.length} edges=${loop.edges.length}`);
    }
}
