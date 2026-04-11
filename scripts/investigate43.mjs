/**
 * investigate43.mjs — Analyze reference STEP face structure
 * 
 * Questions:
 * 1. How many faces per unique plane equation?
 * 2. Do faces share the same plane but different edge loops?
 * 3. How are inner loops (holes) represented?
 * 4. What distinct vertex clusters exist on each plane?
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

// ========== Parse reference STEP ==========
const refPath = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions', 'nist_ctc_01_asme1_rd.stp');
const refContent = fs.readFileSync(refPath, 'utf-8');

// Join continuation lines
const lines = refContent.split('\n');
const fullEntities = [];
let current = '';
for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
        if (current) fullEntities.push(current);
        current = trimmed;
    } else if (trimmed.endsWith(';')) {
        current += ' ' + trimmed;
        fullEntities.push(current);
        current = '';
    } else if (current) {
        current += ' ' + trimmed;
    }
}
if (current) fullEntities.push(current);

// Build entity map
const entityMap = {};
for (const ent of fullEntities) {
    const m = ent.match(/^#(\d+)=\s*(\w+)\s*\((.*)\)\s*;?$/s);
    if (m) {
        entityMap[m[1]] = { type: m[2], args: m[3].trim(), raw: ent };
    }
}

// Helpers
function parseCartesianPoint(id) {
    const e = entityMap[id];
    if (!e || e.type !== 'CARTESIAN_POINT') return null;
    const nums = e.args.match(/-?[\d.]+(?:E[+-]?\d+)?/gi);
    if (!nums || nums.length < 3) return null;
    return { x: parseFloat(nums[0]), y: parseFloat(nums[1]), z: parseFloat(nums[2]) };
}

function parseDirection(id) {
    const e = entityMap[id];
    if (!e || e.type !== 'DIRECTION') return null;
    const nums = e.args.match(/-?[\d.]+(?:E[+-]?\d+)?/gi);
    if (!nums || nums.length < 3) return null;
    return { x: parseFloat(nums[0]), y: parseFloat(nums[1]), z: parseFloat(nums[2]) };
}

function parseAxis2(id) {
    const e = entityMap[id];
    if (!e || e.type !== 'AXIS2_PLACEMENT_3D') return null;
    const refs = e.args.match(/#(\d+)/g);
    if (!refs || refs.length < 2) return null;
    const origin = parseCartesianPoint(refs[0].slice(1));
    const dir = parseDirection(refs[1].slice(1));
    const refDir = refs[2] ? parseDirection(refs[2].slice(1)) : null;
    return { origin, dir, refDir };
}

// ========== Analyze ADVANCED_FACEs ==========
const faceData = [];
for (const [id, ent] of Object.entries(entityMap)) {
    if (ent.type !== 'ADVANCED_FACE') continue;
    
    // Parse: '',(bounds...),#surfaceId,.T./.F.
    const refs = ent.args.match(/#(\d+)/g);
    if (!refs || refs.length < 2) continue;
    
    const surfaceRef = refs[refs.length - 1].slice(1);
    const surfEnt = entityMap[surfaceRef];
    if (!surfEnt) continue;
    
    // Get surface type and params
    let surfType = surfEnt.type;
    let planeEq = null;
    
    if (surfType === 'PLANE') {
        const axRef = surfEnt.args.match(/#(\d+)/);
        if (axRef) {
            const ax = parseAxis2(axRef[1]);
            if (ax && ax.origin && ax.dir) {
                const n = ax.dir;
                const o = ax.origin;
                const d = n.x * o.x + n.y * o.y + n.z * o.z;
                planeEq = { normal: n, d, origin: o };
            }
        }
    }
    
    // Count bounds
    const boundRefs = refs.slice(0, -1); // all refs except surface
    let outerBounds = 0;
    let innerBounds = 0;
    for (const ref of boundRefs) {
        const bid = ref.slice(1);
        const bent = entityMap[bid];
        if (!bent) continue;
        if (bent.type === 'FACE_OUTER_BOUND') outerBounds++;
        else if (bent.type === 'FACE_BOUND') innerBounds++;
    }
    
    faceData.push({
        id,
        surfType,
        planeEq,
        outerBounds,
        innerBounds,
        totalBounds: outerBounds + innerBounds,
    });
}

console.log(`Total ADVANCED_FACEs: ${faceData.length}`);

// Group faces by surface type
const byType = {};
for (const f of faceData) {
    byType[f.surfType] = byType[f.surfType] || [];
    byType[f.surfType].push(f);
}
for (const [type, faces] of Object.entries(byType)) {
    console.log(`  ${type}: ${faces.length} faces`);
}

// ========== Group PLANE faces by equation ==========
const planeGroups = [];
const NORMAL_TOL = 0.01;
const DIST_TOL = 1.0; // mm

for (const f of faceData.filter(f => f.surfType === 'PLANE' && f.planeEq)) {
    let found = false;
    for (const group of planeGroups) {
        const gn = group.normal;
        const fn = f.planeEq.normal;
        const dot = gn.x * fn.x + gn.y * fn.y + gn.z * fn.z;
        if (Math.abs(Math.abs(dot) - 1) < NORMAL_TOL) {
            const sign = dot > 0 ? 1 : -1;
            if (Math.abs(f.planeEq.d - sign * group.d) < DIST_TOL) {
                group.faces.push(f);
                found = true;
                break;
            }
        }
    }
    if (!found) {
        planeGroups.push({
            normal: f.planeEq.normal,
            d: f.planeEq.d,
            faces: [f],
        });
    }
}

console.log(`\n=== Unique plane equations in reference: ${planeGroups.length} ===`);
console.log('Faces per plane equation:');
const facesPerPlane = planeGroups.map(g => g.faces.length).sort((a, b) => a - b);
const histogram = {};
for (const c of facesPerPlane) {
    histogram[c] = (histogram[c] || 0) + 1;
}
for (const [count, n] of Object.entries(histogram).sort((a,b) => parseInt(a) - parseInt(b))) {
    console.log(`  ${count} face(s): ${n} plane equations`);
}

// ========== Inner/outer loops distribution ==========
console.log('\n=== Bounds distribution ===');
const boundsHist = {};
for (const f of faceData) {
    const key = `${f.outerBounds} outer + ${f.innerBounds} inner`;
    boundsHist[key] = (boundsHist[key] || 0) + 1;
}
for (const [combo, count] of Object.entries(boundsHist).sort()) {
    console.log(`  ${combo}: ${count} faces`);
}

// Show the plane groups with multiple faces
console.log(`\n=== Plane equations with multiple faces ===`);
for (const group of planeGroups.filter(g => g.faces.length > 1)) {
    const n = group.normal;
    console.log(`  n=(${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)}), d=${group.d.toFixed(2)}: ${group.faces.length} faces`);
    for (const f of group.faces) {
        console.log(`    face #${f.id}: ${f.outerBounds} outer + ${f.innerBounds} inner bounds`);
    }
}

// ========== Vertex clustering analysis ==========
// For CTC_01, load our parsed model and check vertex clusters per plane
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

// For each surface in our model that's a plane, find vertex clusters
// using connected components (vertices within a distance threshold)
console.log(`\n=== Our model: vertex clustering per plane ===`);
const planeSurfaces = model.surfaces.filter(s => s.surfaceType === 'plane');

for (const surf of planeSurfaces.slice(0, 5)) {
    const p = surf.params;
    const origin = p.origin;
    const normal = p.normal;
    
    // Find vertices on this plane
    const onPlane = [];
    for (const v of model.vertices) {
        const dx = v.position.x - origin.x;
        const dy = v.position.y - origin.y;
        const dz = v.position.z - origin.z;
        const dist = Math.abs(dx * normal.x + dy * normal.y + dz * normal.z);
        if (dist < 0.5) {
            onPlane.push(v);
        }
    }
    
    // Project to 2D and cluster by connectivity
    // Simple approach: connected components where edge <= threshold
    const CLUSTER_DIST = 50; // mm — max edge length within a cluster
    
    // Build adjacency using 2D nearest-neighbor
    const assigned = new Array(onPlane.length).fill(-1);
    let nextCluster = 0;
    
    for (let i = 0; i < onPlane.length; i++) {
        if (assigned[i] >= 0) continue;
        // BFS from this vertex
        const cluster = nextCluster++;
        const queue = [i];
        assigned[i] = cluster;
        while (queue.length > 0) {
            const ci = queue.shift();
            const cv = onPlane[ci].position;
            for (let j = 0; j < onPlane.length; j++) {
                if (assigned[j] >= 0) continue;
                const jv = onPlane[j].position;
                const d = Math.sqrt(
                    (cv.x - jv.x) ** 2 + (cv.y - jv.y) ** 2 + (cv.z - jv.z) ** 2
                );
                if (d <= CLUSTER_DIST) {
                    assigned[j] = cluster;
                    queue.push(j);
                }
            }
        }
    }
    
    const clusterSizes = {};
    for (const c of assigned) {
        clusterSizes[c] = (clusterSizes[c] || 0) + 1;
    }
    
    const n = normal;
    console.log(`  Plane n=(${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}): ${onPlane.length} verts → ${nextCluster} clusters (sizes: ${Object.values(clusterSizes).sort((a,b)=>b-a).join(', ')})`);
}
