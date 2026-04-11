/**
 * investigate48.mjs — Which cylinders are still NOT detected as holes?
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

const cylinders = model.surfaces.filter(s => s.surfaceType === 'cylinder');
const planes = model.surfaces.filter(s => s.surfaceType === 'plane');

// Build inverse: which cylinders appear as inner loops?
const cylsUsedAsHoles = new Set();
for (const face of model.faces) {
    for (const ilId of face.innerLoops) {
        const loop = model.loops.find(l => l.id === ilId);
        if (!loop) continue;
        for (const eid of loop.edges) {
            const edge = model.edges.find(e => e.id === eid);
            if (!edge) continue;
            const curve = model.curves.find(c => c.id === edge.curve);
            if (!curve || curve.curveType !== 'circle') continue;
            // Match this circle to a cylinder
            for (const cyl of cylinders) {
                const cp = cyl.params;
                if (Math.abs(cp.radius - curve.params.radius) < 0.1) {
                    const dx = cp.origin.x - curve.params.center.x;
                    const dy = cp.origin.y - curve.params.center.y;
                    const dz = cp.origin.z - curve.params.center.z;
                    if (Math.sqrt(dx*dx+dy*dy+dz*dz) < cp.radius + 20) {
                        cylsUsedAsHoles.add(cyl.id);
                    }
                }
            }
        }
    }
}

console.log(`Cylinders used as holes: ${cylsUsedAsHoles.size}/${cylinders.length}`);

// Show which cylinders are NOT holes and WHY
let missingCount = 0;
for (const cyl of cylinders) {
    if (cylsUsedAsHoles.has(cyl.id)) continue;
    missingCount++;
    const cp = cyl.params;
    
    // Check all plane faces
    let bestFaceDiag = -1;
    let bestFaceId = -1;
    let bestReason = '';
    
    for (const face of model.faces) {
        const surf = model.surfaces.find(s => s.id === face.surface);
        if (!surf || surf.surfaceType !== 'plane') continue;
        const pp = surf.params;
        const n = pp.normal;
        const dot = cp.axis.x * n.x + cp.axis.y * n.y + cp.axis.z * n.z;
        
        if (Math.abs(Math.abs(dot) - 1) > 0.1) continue;
        
        // Get face hull extent
        const loop = model.loops.find(l => l.id === face.outerLoop);
        if (!loop) continue;
        let faceMinX = Infinity, faceMaxX = -Infinity, faceMinY = Infinity, faceMaxY = -Infinity;
        for (const eid of loop.edges) {
            const edge = model.edges.find(e => e.id === eid);
            if (!edge) continue;
            const sv = model.vertices.find(v => v.id === edge.startVertex);
            if (!sv) continue;
            faceMinX = Math.min(faceMinX, sv.position.x);
            faceMaxX = Math.max(faceMaxX, sv.position.x);
            faceMinY = Math.min(faceMinY, sv.position.y);
            faceMaxY = Math.max(faceMaxY, sv.position.y);
        }
        const diag = Math.sqrt((faceMaxX-faceMinX)**2 + (faceMaxY-faceMinY)**2);
        
        // Check if cylinder center is "near" this face
        const dx = cp.origin.x - pp.origin.x;
        const dy = cp.origin.y - pp.origin.y;
        const dz = cp.origin.z - pp.origin.z;
        const distToPlane = Math.abs(dx * n.x + dy * n.y + dz * n.z);
        
        // Check if cyl center is roughly within face bbox
        const inXRange = cp.origin.x >= faceMinX - cp.radius && cp.origin.x <= faceMaxX + cp.radius;
        const inYRange = cp.origin.y >= faceMinY - cp.radius && cp.origin.y <= faceMaxY + cp.radius;
        
        if (diag > bestFaceDiag) {
            bestFaceDiag = diag;
            bestFaceId = face.id;
            bestReason = `faceDiag=${diag.toFixed(0)} bbox=[${faceMinX.toFixed(0)},${faceMaxX.toFixed(0)}]×[${faceMinY.toFixed(0)},${faceMaxY.toFixed(0)}] inBbox=${inXRange && inYRange} distToPlane=${distToPlane.toFixed(1)}`;
        }
    }
    
    console.log(`  Cyl id=${cyl.id} r=${cp.radius.toFixed(1)} origin=(${cp.origin.x.toFixed(0)},${cp.origin.y.toFixed(0)},${cp.origin.z.toFixed(0)}) axis=(${cp.axis.x.toFixed(1)},${cp.axis.y.toFixed(1)},${cp.axis.z.toFixed(1)})`);
    console.log(`    Closest parallel face #${bestFaceId}: ${bestReason}`);
}
console.log(`\nTotal missing: ${missingCount}`);
