/**
 * investigate32.mjs
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal: Diagnose why plane matching fails (4/80 match rate).
 * Print STEP plane origins/normals alongside closest PS "plane" geometry.
 * Determine if 213 "7-float planes" are actually LINE curves mixed with real planes.
 * Find the correct scale factor and verify geometry extraction.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');
const ctcDefDir = join(stpDir, 'CTC Definitions');
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);

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
                        try { const n = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 }); if (n.length >= 20 && n[0] === 0x50 && n[1] === 0x53 && (!best || n.length > best.length)) best = n; } catch {}
                    }
                    if (dec.length >= 20 && dec[0] === 0x50 && dec[1] === 0x53 && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

// ── Extract geometry from sentinel blocks ───────────────────────────────────

function extractGeometry(ps) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx++; }

    const geometries = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + 6;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        // Find primary entity type
        let primaryType = -1, primaryId = -1;
        for (let j = 0; j + 3 < block.length && j < 8; j++) {
            if (block[j] === 0x00 && block[j + 1] >= 0x0e) {
                primaryType = block[j + 1];
                primaryId = block.readUInt16BE(j + 2);
                break;
            }
        }

        if (primaryType !== 0x1e && primaryType !== 0x1f) continue;

        // Find 0x2B marker followed by valid floats
        for (let j = 4; j < block.length - 9; j++) {
            if (block[j] !== 0x2b) continue;
            const testVal = block.readDoubleBE(j + 1);
            if (!isFinite(testVal) || Math.abs(testVal) > 1e6) continue;

            // Read all consecutive valid floats
            const floats = [];
            for (let k = j + 1; k + 8 <= block.length; k += 8) {
                const v = block.readDoubleBE(k);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                floats.push(v);
            }
            if (floats.length >= 4) {
                geometries.push({ id: primaryId, type: primaryType, floatCount: floats.length, floats, blockSize: block.length });
                break;
            }
        }
    }
    return geometries;
}

// ── Parse STEP reference ────────────────────────────────────────────────────

function parseStepGeometry(path) {
    const text = readFileSync(path, 'utf-8');

    const pts = new Map();
    for (const m of text.matchAll(/#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*\)/g)) {
        pts.set(parseInt(m[1]), m[2].split(',').map(s => parseFloat(s.trim())));
    }
    const dirs = new Map();
    for (const m of text.matchAll(/#(\d+)\s*=\s*DIRECTION\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*\)/g)) {
        dirs.set(parseInt(m[1]), m[2].split(',').map(s => parseFloat(s.trim())));
    }
    const axes = new Map();
    for (const m of text.matchAll(/#(\d+)\s*=\s*AXIS2_PLACEMENT_3D\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*#(\d+)\s*,\s*#(\d+)\s*\)/g)) {
        axes.set(parseInt(m[1]), { loc: parseInt(m[2]), z: parseInt(m[3]), x: parseInt(m[4]) });
    }

    const planes = [];
    for (const m of text.matchAll(/#(\d+)\s*=\s*PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g)) {
        const axis = axes.get(parseInt(m[2]));
        if (!axis) continue;
        const origin = pts.get(axis.loc);
        const normal = dirs.get(axis.z);
        const refDir = dirs.get(axis.x);
        if (origin && normal) planes.push({ id: parseInt(m[1]), origin, normal, refDir });
    }

    const cylinders = [];
    for (const m of text.matchAll(/#(\d+)\s*=\s*CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([-\d.eE+]+)\s*\)/g)) {
        const axis = axes.get(parseInt(m[2]));
        const radius = parseFloat(m[3]);
        if (!axis) continue;
        const origin = pts.get(axis.loc);
        const axisDir = dirs.get(axis.z);
        if (origin && axisDir) cylinders.push({ id: parseInt(m[1]), origin, axisDir, radius });
    }

    return { planes, cylinders };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

const sldFiles = existsSync(sldDir) ? readdirSync(sldDir).filter(f => /\.sldprt$/i.test(f)) : [];
const ctc01File = sldFiles.find(f => f.includes('ctc_01'));
if (!ctc01File) { console.log('No CTC-01 found'); process.exit(0); }

const ps = getLargestPS(join(sldDir, ctc01File));
if (!ps) { console.log('No PS data'); process.exit(1); }

const geom = extractGeometry(ps);
console.log(`Total geometry entities: ${geom.length}`);

// Group by float count
const byFloatCount = {};
for (const g of geom) { byFloatCount[g.floatCount] = (byFloatCount[g.floatCount] || 0) + 1; }
console.log('Float count distribution:', byFloatCount);

// Extract 7-float entities (plane/line candidates)
const sevenFloat = geom.filter(g => g.floatCount === 7);
const eightFloat = geom.filter(g => g.floatCount === 8);
const otherFloat = geom.filter(g => g.floatCount !== 7 && g.floatCount !== 8);

console.log(`\n7-float: ${sevenFloat.length}, 8-float: ${eightFloat.length}, other: ${otherFloat.length}`);

// ── Analyze PS point coordinates ────────────────────────────────────────────
// First, extract point coordinates to understand the coordinate system

function extractPoints(ps) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx++; }

    const points = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + 6;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        // Check for type-0x1D
        for (let j = 0; j + 3 < block.length && j < 8; j++) {
            if (block[j] === 0x00 && block[j + 1] === 0x1d) {
                const id = block.readUInt16BE(j + 2);
                const coordOff = j + 16; // 16 bytes from type marker
                if (coordOff + 24 <= block.length) {
                    const x = block.readDoubleBE(coordOff);
                    const y = block.readDoubleBE(coordOff + 8);
                    const z = block.readDoubleBE(coordOff + 16);
                    if (isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) < 1e4 && Math.abs(y) < 1e4 && Math.abs(z) < 1e4) {
                        points.push({ id, x, y, z });
                    }
                }
                break;
            }
        }
    }
    return points;
}

const psPoints = extractPoints(ps);
console.log(`\nPS points: ${psPoints.length}`);

// Check coordinate ranges
const xVals = psPoints.map(p => p.x);
const yVals = psPoints.map(p => p.y);
const zVals = psPoints.map(p => p.z);
console.log(`  X range: [${Math.min(...xVals).toFixed(6)}, ${Math.max(...xVals).toFixed(6)}]`);
console.log(`  Y range: [${Math.min(...yVals).toFixed(6)}, ${Math.max(...yVals).toFixed(6)}]`);
console.log(`  Z range: [${Math.min(...zVals).toFixed(6)}, ${Math.max(...zVals).toFixed(6)}]`);

// ── Check 7-float origins ranges ────────────────────────────────────────────

const sfOriginX = sevenFloat.map(g => g.floats[0]);
const sfOriginY = sevenFloat.map(g => g.floats[1]);
const sfOriginZ = sevenFloat.map(g => g.floats[2]);
console.log(`\n7-float origin ranges:`);
console.log(`  X: [${Math.min(...sfOriginX).toFixed(6)}, ${Math.max(...sfOriginX).toFixed(6)}]`);
console.log(`  Y: [${Math.min(...sfOriginY).toFixed(6)}, ${Math.max(...sfOriginY).toFixed(6)}]`);
console.log(`  Z: [${Math.min(...sfOriginZ).toFixed(6)}, ${Math.max(...sfOriginZ).toFixed(6)}]`);

// ── Load STEP reference and check scale ─────────────────────────────────────

const stepFiles = existsSync(ctcDefDir) ? readdirSync(ctcDefDir).filter(f => /ctc.01/i.test(f) && /\.stp$/i.test(f)) : [];
if (stepFiles.length === 0) { console.log('No STEP reference found'); process.exit(0); }

const step = parseStepGeometry(join(ctcDefDir, stepFiles[0]));
console.log(`\nSTEP planes: ${step.planes.length}`);
console.log(`STEP cylinders: ${step.cylinders.length}`);

// Check STEP coordinate ranges
const spOriginX = step.planes.map(p => p.origin[0]);
const spOriginY = step.planes.map(p => p.origin[1]);
const spOriginZ = step.planes.map(p => p.origin[2]);
console.log(`\nSTEP plane origin ranges:`);
console.log(`  X: [${Math.min(...spOriginX).toFixed(6)}, ${Math.max(...spOriginX).toFixed(6)}]`);
console.log(`  Y: [${Math.min(...spOriginY).toFixed(6)}, ${Math.max(...spOriginY).toFixed(6)}]`);
console.log(`  Z: [${Math.min(...spOriginZ).toFixed(6)}, ${Math.max(...spOriginZ).toFixed(6)}]`);

// Compare PS points with STEP plane origins to determine scale factor
console.log(`\n=== SCALE FACTOR ANALYSIS ===`);

// Try matching first few PS points to STEP CARTESIAN_POINT references  
// Parse STEP vertex points to get STEP coordinates
const stepText = readFileSync(join(ctcDefDir, stepFiles[0]), 'utf-8');
const stepPts = new Map();
for (const m of stepText.matchAll(/#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*\)/g)) {
    stepPts.set(parseInt(m[1]), m[2].split(',').map(s => parseFloat(s.trim())));
}
const stepVertices = [];
for (const m of stepText.matchAll(/#(\d+)\s*=\s*VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g)) {
    const ptRef = parseInt(m[2]);
    const coords = stepPts.get(ptRef);
    if (coords) stepVertices.push(coords);
}

console.log(`STEP vertices: ${stepVertices.length}`);
const svX = stepVertices.map(v => v[0]);
const svY = stepVertices.map(v => v[1]);
const svZ = stepVertices.map(v => v[2]);
console.log(`  X: [${Math.min(...svX).toFixed(4)}, ${Math.max(...svX).toFixed(4)}]`);
console.log(`  Y: [${Math.min(...svY).toFixed(4)}, ${Math.max(...svY).toFixed(4)}]`);
console.log(`  Z: [${Math.min(...svZ).toFixed(4)}, ${Math.max(...svZ).toFixed(4)}]`);

// Compute scale: STEP_max / PS_max for each axis
const xScale = Math.max(...svX) / Math.max(...xVals);
const yScale = Math.max(...svY) / Math.max(...yVals);
const zScale = Math.max(...svZ) / Math.max(...zVals);
console.log(`\nInferred scale (STEP/PS): X=${xScale.toFixed(4)}, Y=${yScale.toFixed(4)}, Z=${zScale.toFixed(4)}`);

// ── Try matching with inferred scale ────────────────────────────────────────

// Determine the most likely scale factor
const scales = [1, 1000, 25.4, 25400]; // mm, m→mm, inch→mm, inch→m→mm
const scaleLabels = ['1:1', '÷1000 (m→mm)', '÷25.4 (in→mm)', '÷25400 (in→m→mm)'];

console.log(`\n=== PLANE MATCHING WITH DIFFERENT SCALES ===`);
for (let si = 0; si < scales.length; si++) {
    const scale = scales[si];
    let matched = 0;
    for (const sp of step.planes) {
        for (const pg of sevenFloat) {
            const dx = sp.origin[0] - pg.floats[0] * scale;
            const dy = sp.origin[1] - pg.floats[1] * scale;
            const dz = sp.origin[2] - pg.floats[2] * scale;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            const dot = Math.abs(sp.normal[0]*pg.floats[3] + sp.normal[1]*pg.floats[4] + sp.normal[2]*pg.floats[5]);
            if (dist < 0.5 && Math.abs(dot - 1) < 0.02) { matched++; break; }
        }
    }
    console.log(`  Scale ${scaleLabels[si]}: ${matched}/${step.planes.length} planes match`);
}

console.log(`\n=== CYLINDER MATCHING WITH DIFFERENT SCALES ===`);
for (let si = 0; si < scales.length; si++) {
    const scale = scales[si];
    let matched = 0;
    for (const sc of step.cylinders) {
        for (const pg of eightFloat) {
            const dx = sc.origin[0] - pg.floats[0] * scale;
            const dy = sc.origin[1] - pg.floats[1] * scale;
            const dz = sc.origin[2] - pg.floats[2] * scale;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            const rDiff = Math.abs(sc.radius - pg.floats[7] * scale);
            const dot = Math.abs(sc.axisDir[0]*pg.floats[3] + sc.axisDir[1]*pg.floats[4] + sc.axisDir[2]*pg.floats[5]);
            if (dist < 0.5 && Math.abs(dot - 1) < 0.02 && rDiff < 0.5) { matched++; break; }
        }
    }
    console.log(`  Scale ${scaleLabels[si]}: ${matched}/${step.cylinders.length} cylinders match`);
}

// ── Print sample STEP planes and closest PS matches ─────────────────────────

console.log(`\n=== DETAILED MATCHING (first 10 STEP planes) ===`);
for (const sp of step.planes.slice(0, 10)) {
    const o = sp.origin;
    const n = sp.normal;
    console.log(`\n  STEP plane #${sp.id}: origin=(${o[0].toFixed(4)}, ${o[1].toFixed(4)}, ${o[2].toFixed(4)}) normal=(${n[0].toFixed(4)}, ${n[1].toFixed(4)}, ${n[2].toFixed(4)})`);

    // Find closest PS 7-float match (try all scales)
    let bestDist = Infinity, bestScale = 0, bestG = null;
    for (const scale of scales) {
        for (const pg of sevenFloat) {
            const dx = o[0] - pg.floats[0] * scale;
            const dy = o[1] - pg.floats[1] * scale;
            const dz = o[2] - pg.floats[2] * scale;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (dist < bestDist) {
                bestDist = dist;
                bestScale = scale;
                bestG = pg;
            }
        }
    }
    if (bestG) {
        const dot = Math.abs(n[0]*bestG.floats[3] + n[1]*bestG.floats[4] + n[2]*bestG.floats[5]);
        console.log(`    Closest PS: id=${bestG.id} dist=${bestDist.toFixed(4)} scale=${bestScale} dot=${dot.toFixed(4)}`);
        console.log(`    PS floats: [${bestG.floats.map(f => f.toFixed(6)).join(', ')}]`);
    }
}

// ── Print sample STEP cylinders and closest PS matches ──────────────────────

console.log(`\n=== DETAILED MATCHING (first 5 STEP cylinders) ===`);
for (const sc of step.cylinders.slice(0, 5)) {
    const o = sc.origin;
    const a = sc.axisDir;
    console.log(`\n  STEP cyl #${sc.id}: origin=(${o[0].toFixed(4)}, ${o[1].toFixed(4)}, ${o[2].toFixed(4)}) axis=(${a[0].toFixed(4)}, ${a[1].toFixed(4)}, ${a[2].toFixed(4)}) R=${sc.radius.toFixed(6)}`);

    let bestDist = Infinity, bestScale = 0, bestG = null;
    for (const scale of scales) {
        for (const pg of eightFloat) {
            const dx = o[0] - pg.floats[0] * scale;
            const dy = o[1] - pg.floats[1] * scale;
            const dz = o[2] - pg.floats[2] * scale;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (dist < bestDist) {
                bestDist = dist;
                bestScale = scale;
                bestG = pg;
            }
        }
    }
    if (bestG) {
        const dot = Math.abs(a[0]*bestG.floats[3] + a[1]*bestG.floats[4] + a[2]*bestG.floats[5]);
        console.log(`    Closest PS: id=${bestG.id} dist=${bestDist.toFixed(4)} scale=${bestScale} dot=${dot.toFixed(4)} radius_PS=${bestG.floats[7].toFixed(6)}`);
        console.log(`    PS floats: [${bestG.floats.map(f => f.toFixed(6)).join(', ')}]`);
    }
}
