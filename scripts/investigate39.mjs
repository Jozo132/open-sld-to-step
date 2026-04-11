/**
 * investigate39.mjs — Associate vertices with surfaces to discriminate LINE from PLANE
 *
 * Hypothesis: A PLANE surface will have 3+ vertices lying on it (perpendicular
 * distance ≈ 0). A LINE curve will have at most 2 vertices near it.
 * A genuine surface can be bounded by its associated vertex positions.
 *
 * All observations derived from publicly available NIST MBE PMI test files
 * (U.S. Government works, public domain).
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

console.log(`Vertices: ${model.vertices.length}`);
console.log(`Surfaces: ${model.surfaces.length}`);
console.log(`  planes: ${model.surfaces.filter(s => s.surfaceType === 'plane').length}`);
console.log(`  cylinders: ${model.surfaces.filter(s => s.surfaceType === 'cylinder').length}`);

// For each surface, count vertices that lie ON it
const PLANE_TOL = 0.5; // mm tolerance for perpendicular distance
const CYL_TOL = 0.5;   // mm tolerance for radial distance

const vertexAssociations = [];

for (const surf of model.surfaces) {
    const p = surf.params;
    let count = 0;
    const assocVerts = [];
    
    if (surf.surfaceType === 'plane') {
        const ox = p.origin.x, oy = p.origin.y, oz = p.origin.z;
        const nx = p.normal.x, ny = p.normal.y, nz = p.normal.z;
        
        for (const v of model.vertices) {
            // Perpendicular distance from vertex to plane
            const dx = v.position.x - ox;
            const dy = v.position.y - oy;
            const dz = v.position.z - oz;
            const dist = Math.abs(dx * nx + dy * ny + dz * nz);
            if (dist < PLANE_TOL) {
                count++;
                assocVerts.push(v.id);
            }
        }
    } else if (surf.surfaceType === 'cylinder') {
        const ox = p.origin.x, oy = p.origin.y, oz = p.origin.z;
        const ax = p.axis.x, ay = p.axis.y, az = p.axis.z;
        const radius = p.radius;
        
        for (const v of model.vertices) {
            // Distance from vertex to cylinder axis
            const dx = v.position.x - ox;
            const dy = v.position.y - oy;
            const dz = v.position.z - oz;
            // Component along axis
            const dot = dx * ax + dy * ay + dz * az;
            // Perpendicular component
            const px = dx - dot * ax;
            const py = dy - dot * ay;
            const pz = dz - dot * az;
            const radDist = Math.sqrt(px*px + py*py + pz*pz);
            if (Math.abs(radDist - radius) < CYL_TOL) {
                count++;
                assocVerts.push(v.id);
            }
        }
    }
    
    vertexAssociations.push({
        id: surf.id,
        type: surf.surfaceType,
        vertCount: count,
    });
}

// Distribution of vertex counts
console.log('\n=== Vertex associations per surface ===');
const byTypeAndCount = { plane: {}, cylinder: {} };
for (const va of vertexAssociations) {
    const bucket = byTypeAndCount[va.type] || {};
    const key = va.vertCount >= 10 ? '10+' : String(va.vertCount);
    bucket[key] = (bucket[key] || 0) + 1;
    byTypeAndCount[va.type] = bucket;
}

for (const [type, distrib] of Object.entries(byTypeAndCount)) {
    console.log(`\n${type}:`);
    const sorted = Object.entries(distrib).sort((a, b) => {
        const an = a[0] === '10+' ? 10 : parseInt(a[0]);
        const bn = b[0] === '10+' ? 10 : parseInt(b[0]);
        return an - bn;
    });
    for (const [count, n] of sorted) {
        console.log(`  ${count} vertices: ${n} surfaces`);
    }
}

// How many planes would remain if we require >= 3 vertices?
const planes3plus = vertexAssociations.filter(va => va.type === 'plane' && va.vertCount >= 3).length;
const planes4plus = vertexAssociations.filter(va => va.type === 'plane' && va.vertCount >= 4).length;
const cyls2plus = vertexAssociations.filter(va => va.type === 'cylinder' && va.vertCount >= 2).length;
const cyls3plus = vertexAssociations.filter(va => va.type === 'cylinder' && va.vertCount >= 3).length;

console.log(`\n=== Filtering thresholds ===`);
console.log(`Planes with >= 3 vertices: ${planes3plus} (ref: 84)`);
console.log(`Planes with >= 4 vertices: ${planes4plus} (ref: 84)`);
console.log(`Cylinders with >= 2 vertices: ${cyls2plus} (ref: 57)`);
console.log(`Cylinders with >= 3 vertices: ${cyls3plus} (ref: 57)`);

// Also check: are there planes with 0 vertices that are uniquely surface-like?
const zeroVertPlanes = vertexAssociations.filter(va => va.type === 'plane' && va.vertCount === 0);
console.log(`\nPlanes with 0 vertices: ${zeroVertPlanes.length}`);
const oneVertPlanes = vertexAssociations.filter(va => va.type === 'plane' && va.vertCount === 1);
console.log(`Planes with 1 vertex: ${oneVertPlanes.length}`);
const twoVertPlanes = vertexAssociations.filter(va => va.type === 'plane' && va.vertCount === 2);
console.log(`Planes with 2 vertices: ${twoVertPlanes.length}`);
