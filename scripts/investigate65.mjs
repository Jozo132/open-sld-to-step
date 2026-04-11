#!/usr/bin/env node
/**
 * investigate65.mjs — Trace which wrong planes are extracted vs inferred.
 * Also track: is the extracted plane origin correct? Is the inferred dAvg wrong?
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

// We need to trace which planes are extracted vs inferred.
// Re-implement the parse() logic step by step.
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const buf = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const result = SldprtContainerParser.extractParasolid(buf);

// We need to make the parser's private methods accessible.
// Create a parser and use its parse() but also call extractSurfaces() separately.
const parser = new ParasolidParser(result.data);
const model = parser.parse();

// Now, to distinguish extracted vs inferred, we need to call extractSurfaces() directly.
// But it's private. Let's re-create the pipeline manually.
const parser2 = new ParasolidParser(result.data);

// Use prototype hacking to access private methods
const proto = Object.getPrototypeOf(parser2);
const extractSurfaces = proto.extractSurfaces.bind(parser2);
const deduplicateSurfaces = proto.deduplicateSurfaces.bind(parser2);
const inferPlanesFromVertices = proto.inferPlanesFromVertices.bind(parser2);

const PS_TO_MM = 1000;
const rawExtracted = extractSurfaces();
console.log(`Raw extracted surfaces: ${rawExtracted.length} (planes: ${rawExtracted.filter(s=>s.surfaceType==='plane').length}, cyl: ${rawExtracted.filter(s=>s.surfaceType==='cylinder').length}, cone: ${rawExtracted.filter(s=>s.surfaceType==='cone').length})`);

// Step 2: validate planes (from parse())
const points = parser2.extractCoordinates();
const vertices = points.map((pt, i) => ({
    id: i + 1,
    position: { x: pt.x * PS_TO_MM, y: pt.y * PS_TO_MM, z: pt.z * PS_TO_MM }
}));

const VERTEX_PLANE_TOL = 0.5;
const validatedSurfaces = [];
for (const surf of rawExtracted) {
    if (surf.surfaceType === 'plane') {
        const p = surf.params;
        const coplanarVerts = [];
        for (const v of vertices) {
            const dx = v.position.x - p.origin.x;
            const dy = v.position.y - p.origin.y;
            const dz = v.position.z - p.origin.z;
            const dist = Math.abs(dx * p.normal.x + dy * p.normal.y + dz * p.normal.z);
            if (dist < VERTEX_PLANE_TOL) {
                coplanarVerts.push(v.position);
                if (coplanarVerts.length >= 10) break;
            }
        }
        if (coplanarVerts.length < 3) continue;
        let maxArea = 0;
        const nv = coplanarVerts.length;
        outer: for (let i = 0; i < nv; i++) {
            for (let j = i+1; j < nv; j++) {
                for (let k = j+1; k < nv; k++) {
                    const ax = coplanarVerts[j].x - coplanarVerts[i].x;
                    const ay = coplanarVerts[j].y - coplanarVerts[i].y;
                    const az = coplanarVerts[j].z - coplanarVerts[i].z;
                    const bx = coplanarVerts[k].x - coplanarVerts[i].x;
                    const by = coplanarVerts[k].y - coplanarVerts[i].y;
                    const bz = coplanarVerts[k].z - coplanarVerts[i].z;
                    const cx = ay*bz - az*by, cy = az*bx - ax*bz, cz = ax*by - ay*bx;
                    maxArea = Math.max(maxArea, 0.5 * Math.sqrt(cx*cx+cy*cy+cz*cz));
                    if (maxArea >= 0.01) break outer;
                }
            }
        }
        if (maxArea < 0.01) continue;
        validatedSurfaces.push(surf);
    } else {
        validatedSurfaces.push(surf);
    }
}
console.log(`After validation: ${validatedSurfaces.length} (planes: ${validatedSurfaces.filter(s=>s.surfaceType==='plane').length})`);

// Step 3: Infer planes
const inferredPlanes = inferPlanesFromVertices(vertices, validatedSurfaces);
console.log(`Inferred planes: ${inferredPlanes.length}`);

// Step 4: Merge and dedup
const merged = [...validatedSurfaces, ...inferredPlanes];
const deduped = deduplicateSurfaces(merged);
console.log(`After dedup: ${deduped.length} planes`);

// Tag each deduped surface as extracted or inferred
for (const surf of deduped) {
    if (surf.surfaceType !== 'plane') continue;
    const n = surf.params.normal;
    const o = surf.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    
    // Check if it came from extracted (validated) set
    let fromExtracted = false;
    for (const ext of validatedSurfaces) {
        if (ext.surfaceType !== 'plane') continue;
        const en = ext.params.normal;
        const eo = ext.params.origin;
        const dot = Math.abs(n.x*en.x + n.y*en.y + n.z*en.z);
        if (dot < 0.99) continue;
        const ed = en.x*eo.x + en.y*eo.y + en.z*eo.z;
        const sign = (n.x*en.x + n.y*en.y + n.z*en.z) > 0 ? 1 : -1;
        if (Math.abs(d - sign*ed) < 0.5) { fromExtracted = true; break; }
    }
    surf._source = fromExtracted ? 'extracted' : 'inferred';
}

// Load reference
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

function findBestRefMatch(mp) {
    const n = mp.params.normal;
    const o = mp.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    let bestDist = Infinity;
    let bestRef = null;
    for (const rp of refPlanes) {
        const dot = n.x*rp.normal[0] + n.y*rp.normal[1] + n.z*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.05) continue;
        const rd = dot > 0 ? rp.d : -rp.d;
        const dd = Math.abs(d - rd);
        if (dd < bestDist) { bestDist = dd; bestRef = rp; }
    }
    return { bestDist, bestRef };
}

// Print all unmatched planes with source
console.log('\n=== UNMATCHED model planes (bestDist > 1.0mm) ===');
const planes = deduped.filter(s => s.surfaceType === 'plane');
let extractedWrong = 0, inferredWrong = 0;
let extractedRight = 0, inferredRight = 0;

for (const surf of planes) {
    const n = surf.params.normal;
    const o = surf.params.origin;
    const d = n.x*o.x + n.y*o.y + n.z*o.z;
    const { bestDist, bestRef } = findBestRefMatch(surf);
    const matched = bestDist <= 1.0;
    const src = surf._source || 'unknown';
    
    if (matched) {
        if (src === 'extracted') extractedRight++;
        else inferredRight++;
    } else {
        if (src === 'extracted') extractedWrong++;
        else inferredWrong++;
        console.log(`  ${src.padEnd(10)} n=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}) d=${d.toFixed(1)}mm  bestDist=${bestDist.toFixed(1)}mm${bestRef ? ` refD=${(bestRef.d * (n.x*bestRef.normal[0]+n.y*bestRef.normal[1]+n.z*bestRef.normal[2] > 0 ? 1 : -1)).toFixed(1)}` : ''}`);
    }
}

console.log(`\n=== Summary ===`);
console.log(`Extracted: ${extractedRight} matched, ${extractedWrong} wrong`);
console.log(`Inferred:  ${inferredRight} matched, ${inferredWrong} wrong`);
console.log(`Total:     ${extractedRight+inferredRight} matched, ${extractedWrong+inferredWrong} wrong out of ${planes.length} planes`);
