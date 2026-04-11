#!/usr/bin/env node
/**
 * investigate70.mjs — Test vertex-triplet normal discovery.
 * Compute normals from all C(N,3) vertex triplets, cluster them,
 * and see if compound-angle face normals emerge.
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

const PS_TO_MM = 1000;

// Test on CTC_01
const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
for (const [fileName, refPath] of [
    ['nist_ctc_01_asme1_rd_sw1802.SLDPRT', 'CTC Definitions/nist_ctc_01_asme1_rd.stp'],
    ['nist_ctc_03_asme1_rc_sw1802.SLDPRT', 'CTC Definitions/nist_ctc_03_asme1_rc.stp'],
]) {
    const buf = fs.readFileSync(path.join(NIST_DIR, fileName));
    const result = SldprtContainerParser.extractParasolid(buf);
    const parser = new ParasolidParser(result.data);
    const points = parser.extractCoordinates();
    const verts = points.map(p => ({
        x: p.x * PS_TO_MM, y: p.y * PS_TO_MM, z: p.z * PS_TO_MM,
    }));
    
    console.log(`\n=== ${fileName} (${verts.length} vertices) ===`);
    
    const QUANT = 200; // ~0.3° angular resolution
    const normalBins = new Map();
    const N = verts.length;
    const t0 = performance.now();
    
    let tripletCount = 0;
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            for (let k = j + 1; k < N; k++) {
                const pi = verts[i], pj = verts[j], pk = verts[k];
                const ax = pj.x - pi.x, ay = pj.y - pi.y, az = pj.z - pi.z;
                const bx = pk.x - pi.x, by = pk.y - pi.y, bz = pk.z - pi.z;
                let nx = ay*bz - az*by;
                let ny = az*bx - ax*bz;
                let nz = ax*by - ay*bx;
                const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
                if (len < 1e-6) continue;
                nx /= len; ny /= len; nz /= len;
                
                // Normalize to positive hemisphere
                if (nz < -1e-9 || (Math.abs(nz) < 1e-9 && ny < -1e-9) || 
                    (Math.abs(nz) < 1e-9 && Math.abs(ny) < 1e-9 && nx < 0)) {
                    nx = -nx; ny = -ny; nz = -nz;
                }
                
                const kx = Math.round(nx * QUANT);
                const ky = Math.round(ny * QUANT);
                const kz = Math.round(nz * QUANT);
                const key = `${kx},${ky},${kz}`;
                
                if (normalBins.has(key)) {
                    const existing = normalBins.get(key);
                    existing.count++;
                    // Running average for better normal estimate
                    existing.sx += nx; existing.sy += ny; existing.sz += nz;
                } else {
                    normalBins.set(key, { count: 1, sx: nx, sy: ny, sz: nz });
                }
                tripletCount++;
            }
        }
    }
    const elapsed = performance.now() - t0;
    console.log(`  Triplets: ${tripletCount}, time: ${elapsed.toFixed(0)}ms`);
    console.log(`  Unique normal bins: ${normalBins.size}`);
    
    // Sort by count descending
    const sorted = [...normalBins.entries()]
        .map(([key, val]) => {
            const len = Math.sqrt(val.sx*val.sx + val.sy*val.sy + val.sz*val.sz);
            return {
                key,
                count: val.count,
                normal: { x: val.sx/len, y: val.sy/len, z: val.sz/len },
            };
        })
        .sort((a, b) => b.count - a.count);
    
    // Load reference normals
    const refDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
    const refText = fs.readFileSync(path.join(refDir, refPath), 'utf8');
    const refNormals = new Set();
    const planeRe = /PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g;
    let m;
    while ((m = planeRe.exec(refText)) !== null) {
        const axRe = new RegExp(`#${m[1]}\\s*=\\s*AXIS2_PLACEMENT_3D\\s*\\(\\s*'[^']*'\\s*,\\s*#\\d+\\s*,\\s*#(\\d+)`);
        const am = refText.match(axRe);
        if (!am) continue;
        const dirRe = new RegExp(`#${am[1]}\\s*=\\s*DIRECTION\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
        const dm = refText.match(dirRe);
        if (!dm) continue;
        const [nx, ny, nz] = dm[1].split(',').map(Number);
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        // Normalize to positive hemisphere
        let nnx = nx/len, nny = ny/len, nnz = nz/len;
        if (nnz < -1e-9 || (Math.abs(nnz) < 1e-9 && nny < -1e-9) || 
            (Math.abs(nnz) < 1e-9 && Math.abs(nny) < 1e-9 && nnx < 0)) {
            nnx = -nnx; nny = -nny; nnz = -nnz;
        }
        const k = `${Math.round(nnx*QUANT)},${Math.round(nny*QUANT)},${Math.round(nnz*QUANT)}`;
        refNormals.add(k);
    }
    
    console.log(`  Reference unique normals: ${refNormals.size}`);
    
    // Show top normals and mark which match reference
    console.log(`\n  Top 30 normals by triplet count:`);
    let discoveredRef = 0;
    for (let i = 0; i < Math.min(30, sorted.length); i++) {
        const s = sorted[i];
        const n = s.normal;
        const isRef = refNormals.has(s.key);
        if (isRef) discoveredRef++;
        const isAxis = (Math.abs(n.x) > 0.99 || Math.abs(n.y) > 0.99 || Math.abs(n.z) > 0.99);
        console.log(`    ${isRef ? '✓' : ' '} count=${String(s.count).padStart(6)} n=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)})${isAxis ? ' [axis]' : ''}`);
    }
    
    // Check: at what count threshold do we capture all non-axis ref normals?
    console.log(`\n  Threshold analysis:`);
    for (const thresh of [1, 2, 4, 6, 10, 20, 50, 100]) {
        const candidates = sorted.filter(s => s.count >= thresh);
        const refFound = candidates.filter(s => refNormals.has(s.key)).length;
        // Count non-axis ref normals
        const nonAxisRef = [...refNormals].filter(k => {
            const [x, y, z] = k.split(',').map(Number);
            return !(Math.abs(x) > QUANT*0.99 || Math.abs(y) > QUANT*0.99 || Math.abs(z) > QUANT*0.99);
        });
        const nonAxisFound = candidates.filter(s => {
            const n = s.normal;
            const isAxis = (Math.abs(n.x) > 0.99 || Math.abs(n.y) > 0.99 || Math.abs(n.z) > 0.99);
            return !isAxis && refNormals.has(s.key);
        }).length;
        console.log(`    threshold≥${String(thresh).padStart(4)}: ${candidates.length} normals, ${refFound}/${refNormals.size} ref found (${nonAxisFound} non-axis from ${nonAxisRef.length} ref non-axis)`);
    }
}
