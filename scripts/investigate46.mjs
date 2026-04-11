/**
 * investigate46.mjs — Vertex distribution on main planes + clustering impact
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

// Use internal methods to get surfaces and vertices
const coords = parser.extractCoordinates();
const PS_TO_MM = 1000;
const vertices = coords.map(c => ({ x: c.x * PS_TO_MM, y: c.y * PS_TO_MM, z: c.z * PS_TO_MM }));

const rawSurfaces = parser.extractSurfaces();
const dedupSurfaces = parser.deduplicateSurfaces(rawSurfaces);
const planes = dedupSurfaces.filter(s => s.surfaceType === 'plane');

// Surface origins/radii already in mm from extractSurfaces() — do NOT scale again

// Associate vertices with planes
const VERTEX_PLANE_TOL = 0.5;
const planeVerts = new Map();
for (const p of planes) {
    const verts = [];
    const n = p.params.normal;
    const o = p.params.origin;
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        const dx = v.x - o.x, dy = v.y - o.y, dz = v.z - o.z;
        const dist = Math.abs(dx * n.x + dy * n.y + dz * n.z);
        if (dist < VERTEX_PLANE_TOL) {
            verts.push(i);
        }
    }
    planeVerts.set(p.id, verts);
}

// Show vertex distribution for the largest planes
console.log('=== Plane vertex analysis (sorted by vertex count) ===');
const sorted = [...planeVerts.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [pid, vids] of sorted.slice(0, 15)) {
    const plane = planes.find(p => p.id === pid);
    const n = plane.params.normal;
    const o = plane.params.origin;
    
    const pts = vids.map(i => vertices[i]);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), zs = pts.map(p => p.z);
    const bbox = `X:[${Math.min(...xs).toFixed(0)},${Math.max(...xs).toFixed(0)}] Y:[${Math.min(...ys).toFixed(0)},${Math.max(...ys).toFixed(0)}] Z:[${Math.min(...zs).toFixed(0)},${Math.max(...zs).toFixed(0)}]`;
    
    console.log(`Plane ${pid}: n=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) verts=${vids.length} ${bbox}`);
    
    // Test clustering at different thresholds
    for (const threshold of [60, 150, 300, 500]) {
        const clusters = clusterPoints(pts, threshold);
        const sizes = clusters.map(c => c.length).sort((a,b) => b-a);
        console.log(`  threshold=${threshold}mm → ${clusters.length} clusters: [${sizes.slice(0,5).join(',')}${sizes.length > 5 ? ',...' : ''}]`);
    }
}

function clusterPoints(pts, threshold) {
    const n = pts.length;
    const parent = Array.from({length: n}, (_, i) => i);
    function find(x) {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
    function union(a, b) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    }
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dx = pts[i].x - pts[j].x;
            const dy = pts[i].y - pts[j].y;
            const dz = pts[i].z - pts[j].z;
            if (Math.sqrt(dx*dx + dy*dy + dz*dz) < threshold) {
                union(i, j);
            }
        }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(pts[i]);
    }
    return [...groups.values()];
}

// Now analyze what happens with larger thresholds for total face count
console.log('\n=== Total face count at different clustering thresholds ===');
for (const threshold of [60, 100, 150, 200, 300, 500, 1000]) {
    let totalFaces = 0;
    let facesWithEnoughVerts = 0;
    for (const [pid, vids] of planeVerts.entries()) {
        if (vids.length < 3) continue;
        const pts = vids.map(i => vertices[i]);
        const clusters = clusterPoints(pts, threshold);
        for (const cluster of clusters) {
            if (cluster.length >= 3) {
                facesWithEnoughVerts++;
            }
        }
        totalFaces += clusters.length;
    }
    console.log(`  threshold=${threshold}mm → ${facesWithEnoughVerts} plane faces (≥3 verts), ${totalFaces} total clusters`);
}
