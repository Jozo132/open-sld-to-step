/**
 * investigate95.mjs — Vertex dimensionality test for LINE/PLANE classification
 *
 * Hypothesis: For each 7-float type-0x1E entity with ≥3 coplanar vertices,
 * project vertices onto the plane and check their 2D spread.
 * - LINE curves → vertices arranged in 1D (collinear)
 * - PLANE surfaces → vertices spread in 2D
 *
 * Metric: PCA eigenvalue ratio λ1/λ2. High ratio → LINE, low → PLANE.
 *
 * Cross-reference with CTC_01 reference to validate.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

function isParasolid(buf) {
    if (buf.length < 20 || buf[0] !== 0x50 || buf[1] !== 0x53) return false;
    return buf.indexOf('TRANSMIT', 0, 'ascii') >= 0 && buf.indexOf('TRANSMIT', 0, 'ascii') < 32;
}

function getLargestPS(filePath) {
    const buf = readFileSync(filePath);
    let best = null, idx = 0;
    while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const cs = buf.readUInt32LE(idx + 14), ds = buf.readUInt32LE(idx + 18), nl = buf.readUInt32LE(idx + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50_000_000) {
            const po = idx + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (isParasolid(nested) && (!best || nested.length > best.length)) best = nested;
                        } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reference plane normals from CTC_01 (extracted manually from reference STEP)
// ═══════════════════════════════════════════════════════════════════════════════

// Parse reference STEP for CTC_01 to get plane normals and d-values
function loadRefPlanes(stepPath) {
    const text = readFileSync(stepPath, 'utf8');
    const planes = [];
    // Find PLANE entities: PLANE('',#axis)
    const planeRe = /#(\d+)\s*=\s*PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/gi;
    let m;
    while ((m = planeRe.exec(text)) !== null) {
        const axisId = parseInt(m[2]);
        // Find AXIS2_PLACEMENT_3D for this axis
        const axisRe = new RegExp(`#${axisId}\\s*=\\s*AXIS2_PLACEMENT_3D\\s*\\(\\s*'[^']*'\\s*,\\s*#(\\d+)\\s*,\\s*#(\\d+)`, 'i');
        const am = axisRe.exec(text);
        if (!am) continue;
        const ptId = parseInt(am[1]);
        const dirId = parseInt(am[2]);
        // Get point coordinates
        const ptRe = new RegExp(`#${ptId}\\s*=\\s*CARTESIAN_POINT\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`, 'i');
        const pm = ptRe.exec(text);
        if (!pm) continue;
        const pt = pm[1].split(',').map(Number);
        // Get direction
        const dirRe = new RegExp(`#${dirId}\\s*=\\s*DIRECTION\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`, 'i');
        const dm = dirRe.exec(text);
        if (!dm) continue;
        const dir = dm[1].split(',').map(Number);
        const d = pt[0] * dir[0] + pt[1] * dir[1] + pt[2] * dir[2];
        planes.push({ normal: dir, d, origin: pt });
    }
    return planes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extract geometry + vertices from Parasolid binary
// ═══════════════════════════════════════════════════════════════════════════════

function extractGeometryAndVertices(ps) {
    // Extract vertices (type-0x1D = 29)
    const vertices = [];
    const sentPositions = [];
    let idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx += SENTINEL.length; }

    // Type-29 in gap after sentinel
    for (const sentOff of sentPositions) {
        const gapStart = sentOff + 8;
        if (gapStart + 42 > ps.length) continue;
        const t = ps.readUInt16BE(gapStart + 2);
        if (t !== 29) continue;
        const id = ps.readUInt16BE(gapStart + 4);
        const z = ps.readUInt16BE(gapStart + 6);
        const o = ps.readUInt16BE(gapStart + 10);
        if (z !== 0 || o !== 1 || id < 1) continue;
        const x = ps.readDoubleBE(gapStart + 18);
        const y = ps.readDoubleBE(gapStart + 26);
        const z3 = ps.readDoubleBE(gapStart + 34);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z3)) continue;
        if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z3) > 1e4) continue;
        vertices.push({ x: x * 1000, y: y * 1000, z: z3 * 1000 }); // meters→mm
    }

    // Also extract using point header scan
    for (let off = 0; off + 40 < ps.length; off++) {
        if (ps[off] !== 0x00 || ps[off + 1] !== 0x1d) continue;
        if (ps[off + 4] !== 0x00 || ps[off + 5] !== 0x00) continue;
        if (ps[off + 8] !== 0x00 || ps[off + 9] !== 0x01) continue;
        const x = ps.readDoubleBE(off + 16);
        const y = ps.readDoubleBE(off + 24);
        const z3 = ps.readDoubleBE(off + 32);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z3)) continue;
        if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z3) > 1e4) continue;
        vertices.push({ x: x * 1000, y: y * 1000, z: z3 * 1000 });
    }

    // Deduplicate
    const seen = new Set();
    const uniqueVerts = vertices.filter(v => {
        const k = `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    // Extract 7-float type-0x1E entities (candidate planes)
    const candidates = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + SENTINEL.length;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        let searchStart = 0;
        while (true) {
            const sepIdx = block.indexOf(SUB_SEP, searchStart);
            if (sepIdx < 0) break;
            searchStart = sepIdx + SUB_SEP.length;
            const rec = block.subarray(searchStart);
            if (rec.length < 4 || rec[0] !== 0x00 || rec[1] !== 0x1e) continue;
            const id = rec.readUInt16BE(2);
            const data = rec.subarray(4);

            // Find marker + geometry floats
            for (let off = 0; off < data.length - 1; off++) {
                if (data[off] !== 0x2b && data[off] !== 0x2d) continue;
                const floats = [];
                for (let fo = off + 1; fo + 8 <= data.length; fo += 8) {
                    const v = data.readDoubleBE(fo);
                    if (!isFinite(v) || Math.abs(v) > 1e6) break;
                    floats.push(v);
                }
                if (floats.length === 7 || floats.length === 8) {
                    const dirMag = Math.sqrt(floats[3]**2 + floats[4]**2 + floats[5]**2);
                    if (dirMag > 0.9 && dirMag < 1.1) {
                        candidates.push({
                            id,
                            origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
                            normal: { x: floats[3], y: floats[4], z: floats[5] },
                            d: (floats[0] * floats[3] + floats[1] * floats[4] + floats[2] * floats[5]) * 1000,
                        });
                    }
                }
                break;
            }
        }
    }

    return { vertices: uniqueVerts, candidates };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PCA-based dimensionality test
// ═══════════════════════════════════════════════════════════════════════════════

function computeEigenRatio(points2D) {
    if (points2D.length < 3) return Infinity;
    // Compute centroid
    let cx = 0, cy = 0;
    for (const p of points2D) { cx += p.u; cy += p.v; }
    cx /= points2D.length; cy /= points2D.length;

    // Compute covariance matrix
    let cov00 = 0, cov01 = 0, cov11 = 0;
    for (const p of points2D) {
        const du = p.u - cx, dv = p.v - cy;
        cov00 += du * du;
        cov01 += du * dv;
        cov11 += dv * dv;
    }
    cov00 /= points2D.length;
    cov01 /= points2D.length;
    cov11 /= points2D.length;

    // Eigenvalues of 2x2 symmetric matrix: λ = (trace ± sqrt(trace² - 4*det)) / 2
    const trace = cov00 + cov11;
    const det = cov00 * cov11 - cov01 * cov01;
    const disc = trace * trace - 4 * det;
    if (disc < 0) return 1; // shouldn't happen for symmetric
    const sqrtDisc = Math.sqrt(disc);
    const lambda1 = (trace + sqrtDisc) / 2;
    const lambda2 = (trace - sqrtDisc) / 2;

    if (lambda2 < 1e-10) return Infinity; // perfectly collinear
    return lambda1 / lambda2;
}

function projectToPlane(vertices, normal) {
    // Create orthonormal basis on the plane
    const nx = normal.x, ny = normal.y, nz = normal.z;
    // Find a vector not parallel to normal
    let ux, uy, uz;
    if (Math.abs(nx) < 0.9) {
        ux = 0; uy = -nz; uz = ny; // cross(n, [1,0,0])
    } else {
        ux = nz; uy = 0; uz = -nx; // cross(n, [0,1,0])
    }
    const umag = Math.sqrt(ux*ux + uy*uy + uz*uz);
    ux /= umag; uy /= umag; uz /= umag;
    // v = cross(n, u)
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    return vertices.map(p => ({
        u: p.x * ux + p.y * uy + p.z * uz,
        v: p.x * vx + p.y * vy + p.z * vz,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main analysis on CTC_01
// ═══════════════════════════════════════════════════════════════════════════════

const fname = 'nist_ctc_01_asme1_rd_sw1802.SLDPRT';
const ps = getLargestPS(join(dir, fname));
console.log(`File: ${fname}, buffer: ${ps.length} bytes\n`);

const { vertices, candidates } = extractGeometryAndVertices(ps);
console.log(`Vertices: ${vertices.length}, Candidates (7-float planes): ${candidates.length}\n`);

// Load reference planes
const refPlanes = loadRefPlanes('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_01_asme1_rd.stp');
console.log(`Reference planes: ${refPlanes.length}\n`);

// For each candidate, find coplanar vertices and compute eigenvalue ratio
const PLANE_DIST_THRESH = 0.5; // mm
const results = [];

for (const cand of candidates) {
    const nx = cand.normal.x, ny = cand.normal.y, nz = cand.normal.z;
    const d = cand.d;

    // Find coplanar vertices
    const coplanar = vertices.filter(v => {
        const dist = Math.abs(v.x * nx + v.y * ny + v.z * nz - d);
        return dist < PLANE_DIST_THRESH;
    });

    if (coplanar.length < 3) continue;

    // Project to 2D and compute eigenvalue ratio
    const proj = projectToPlane(coplanar, cand.normal);
    const ratio = computeEigenRatio(proj);

    // Check if this matches any reference plane
    let refMatch = false;
    for (const ref of refPlanes) {
        const dotN = Math.abs(nx * ref.normal[0] + ny * ref.normal[1] + nz * ref.normal[2]);
        if (dotN < 0.999) continue;
        const dDiff = Math.abs(d - ref.d);
        if (dDiff < 0.5) { refMatch = true; break; }
    }

    results.push({
        id: cand.id,
        normal: `(${nx.toFixed(3)}, ${ny.toFixed(3)}, ${nz.toFixed(3)})`,
        d: d.toFixed(2),
        nVertices: coplanar.length,
        ratio: ratio,
        isRefPlane: refMatch,
    });
}

// Sort by eigenvalue ratio
results.sort((a, b) => a.ratio - b.ratio);

console.log('=== CANDIDATES SORTED BY EIGENVALUE RATIO ===');
console.log('Low ratio = 2D spread (PLANE), High ratio = 1D collinear (LINE)\n');
console.log('id    | ratio    | verts | refMatch | normal              | d');
console.log('------|----------|-------|----------|---------------------|--------');

for (const r of results) {
    const ratioStr = r.ratio === Infinity ? '  Inf   ' : r.ratio.toFixed(2).padStart(8);
    const matchStr = r.isRefPlane ? ' YES   ' : '  no   ';
    console.log(`${String(r.id).padStart(5)} | ${ratioStr} | ${String(r.nVertices).padStart(5)} | ${matchStr} | ${r.normal} | ${r.d}`);
}

// Analyze separation
const truePositives = results.filter(r => r.isRefPlane);
const falsePositives = results.filter(r => !r.isRefPlane);

console.log(`\n=== SEPARATION ANALYSIS ===`);
console.log(`True planes (ref match): ${truePositives.length}`);
console.log(`  Ratio range: ${Math.min(...truePositives.map(r => r.ratio)).toFixed(2)} - ${Math.max(...truePositives.map(r => r.ratio === Infinity ? 0 : r.ratio)).toFixed(2)}`);
console.log(`  Median ratio: ${truePositives.sort((a, b) => a.ratio - b.ratio)[Math.floor(truePositives.length / 2)]?.ratio.toFixed(2)}`);

console.log(`False planes (no ref match): ${falsePositives.length}`);
if (falsePositives.length > 0) {
    console.log(`  Ratio range: ${Math.min(...falsePositives.map(r => r.ratio)).toFixed(2)} - ${Math.max(...falsePositives.map(r => r.ratio === Infinity ? 0 : r.ratio)).toFixed(2)}`);
    console.log(`  Median ratio: ${falsePositives.sort((a, b) => a.ratio - b.ratio)[Math.floor(falsePositives.length / 2)]?.ratio.toFixed(2)}`);
}

// Test threshold effectiveness
for (const thresh of [2, 3, 5, 8, 10, 15, 20, 50, 100]) {
    const kept = results.filter(r => r.ratio <= thresh);
    const tp = kept.filter(r => r.isRefPlane).length;
    const fp = kept.filter(r => !r.isRefPlane).length;
    const removed = results.filter(r => r.ratio > thresh);
    const removedTP = removed.filter(r => r.isRefPlane).length;
    console.log(`  Threshold ${String(thresh).padStart(3)}: keep ${kept.length} (TP=${tp}, FP=${fp}), remove ${removed.length} (lost TP=${removedTP})`);
}
