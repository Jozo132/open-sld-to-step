/**
 * investigate33.mjs
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Quick diagnostic: what do the first bytes of sentinel blocks look like?
 * And: full scale-factor validation for surface geometry using the proven
 * sub-record separator parsing approach from investigate31.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');
const ctcDefDir = join(stpDir, 'CTC Definitions');
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

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

// Use the proven sub-record separator entity parser
function parseEntities(ps) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx++; }
    const entities = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + 6;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;
        const subStarts = [0];
        let searchFrom = 0;
        while (searchFrom < block.length - 6) {
            const sepIdx = block.indexOf(SUB_SEP, searchFrom);
            if (sepIdx < 0) break;
            subStarts.push(sepIdx + 6);
            searchFrom = sepIdx + 6;
        }
        for (let si = 0; si < subStarts.length; si++) {
            const recStart = subStarts[si];
            const recEnd = (si + 1 < subStarts.length) ? subStarts[si + 1] - 6 : block.length;
            if (recStart + 4 > block.length) continue;
            const rec = block.subarray(recStart, recEnd);
            let type = -1, id = -1, dataOff = -1;
            if (si === 0 && rec.length >= 8 && rec.readUInt32BE(0) === 3) {
                type = rec.readUInt16BE(4);
                id = rec.readUInt16BE(6);
                dataOff = 8;
            } else if (rec.length >= 4 && rec[0] === 0x00 && rec[1] >= 0x0d && rec[1] <= 0x85) {
                type = rec.readUInt16BE(0);
                id = rec.readUInt16BE(2);
                dataOff = 4;
            }
            if (type < 0) continue;
            entities.push({ type, id, data: rec.subarray(dataOff), blockIdx: i, blockSize: block.length });
        }
    }
    return entities;
}

const sldFiles = existsSync(sldDir) ? readdirSync(sldDir).filter(f => /\.sldprt$/i.test(f)) : [];
const ctc01File = sldFiles.find(f => f.includes('ctc_01'));
if (!ctc01File) { console.log('No CTC-01'); process.exit(0); }
const ps = getLargestPS(join(sldDir, ctc01File));
if (!ps) { console.log('No PS'); process.exit(1); }

// ── Quick diagnostic: sentinel block headers ────────────────────────────────

const sentPositions = [];
let sidx = 0;
while ((sidx = ps.indexOf(SENTINEL, sidx)) >= 0) { sentPositions.push(sidx); sidx++; }

console.log(`=== SENTINEL BLOCK HEADERS (first 20) ===`);
for (let i = 0; i < Math.min(20, sentPositions.length); i++) {
    const start = sentPositions[i] + 6;
    const end = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
    const len = end - start;
    const first16 = [...ps.subarray(start, Math.min(start + 16, end))].map(b => b.toString(16).padStart(2, '0')).join(' ');
    // Try readUInt32BE(0) to see the header
    const hdr = ps.readUInt32BE(start);
    const typeField = len >= 6 ? ps.readUInt16BE(start + 4) : -1;
    const idField = len >= 8 ? ps.readUInt16BE(start + 6) : -1;
    console.log(`  block[${i}] len=${len} hdr=0x${hdr.toString(16)} type=0x${typeField.toString(16)} id=${idField}: ${first16}`);
}

// Show blocks that would have type >= 0x1E
let geomBlockCount = 0;
for (let i = 0; i < sentPositions.length; i++) {
    const start = sentPositions[i] + 6;
    const end = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
    if (end - start < 8) continue;
    const hdr = ps.readUInt32BE(start);
    if (hdr !== 3) continue; // Not our expected header
    const typeField = ps.readUInt16BE(start + 4);
    if (typeField === 0x1e || typeField === 0x1f) geomBlockCount++;
}
console.log(`\nBlocks with header=3 and type 0x1E/0x1F: ${geomBlockCount}`);

// Check if entities found via sub-record approach are primary (blockIdx unique)
const entities = parseEntities(ps);
console.log(`\nTotal entities via sub-record parser: ${entities.length}`);

const type1E = entities.filter(e => (e.type & 0xff) === 0x1e);
const type1F = entities.filter(e => (e.type & 0xff) === 0x1f);
console.log(`Type-0x1E entities: ${type1E.length}`);
console.log(`Type-0x1F entities: ${type1F.length}`);

// Check if these are primary (first in block) or sub-records
const primaryBlocks = new Set();
const subRecordBlocks = new Set();
for (const e of [...type1E, ...type1F]) {
    if (e.blockIdx !== undefined) {
        // Is this entity the first in its block?
        const blockStart = sentPositions[e.blockIdx] + 6;
        const hdr = ps.readUInt32BE(blockStart);
        const blockType = hdr === 3 ? ps.readUInt16BE(blockStart + 4) : -1;
        if (blockType === (e.type & 0xff)) {
            primaryBlocks.add(e.blockIdx);
        } else {
            subRecordBlocks.add(e.blockIdx);
        }
    }
}
console.log(`  → Primary (first in block): ${primaryBlocks.size}`);
console.log(`  → Sub-record (within block): ${subRecordBlocks.size}`);

// ── Now extract geometry from type-0x1E/0x1F entities ───────────────────────

function extractFloatsAfter2B(data) {
    for (let j = 0; j < data.length - 9; j++) {
        if (data[j] === 0x2b) {
            const testVal = data.readDoubleBE(j + 1);
            if (!isFinite(testVal) || Math.abs(testVal) > 1e6) continue;
            const floats = [];
            for (let k = j + 1; k + 8 <= data.length; k += 8) {
                const v = data.readDoubleBE(k);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                floats.push(v);
            }
            if (floats.length >= 4) return { offset: j, floats };
        }
    }
    return null;
}

const geometries = [];
for (const e of [...type1E, ...type1F]) {
    const g = extractFloatsAfter2B(e.data);
    if (g) geometries.push({ id: e.id, type: e.type, ...g });
}

console.log(`\nGeometries with 0x2B + floats: ${geometries.length}`);

// Float count distribution
const byCount = {};
for (const g of geometries) { byCount[g.floats.length] = (byCount[g.floats.length] || 0) + 1; }
console.log('Float count distribution:', JSON.stringify(byCount));

// ── Point coordinate ranges (for scale reference) ───────────────────────────

const points = [];
for (const e of entities) {
    if ((e.type & 0xff) !== 0x1d) continue;
    const d = e.data;
    if (d.length < 36) continue;
    if (d[0] !== 0x00 || d[1] !== 0x00) continue;
    if (d[4] !== 0x00 || d[5] !== 0x01) continue;
    const x = d.readDoubleBE(12), y = d.readDoubleBE(20), z = d.readDoubleBE(28);
    if (isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) < 1e4) {
        points.push({ id: e.id, x, y, z });
    }
}
console.log(`\nPS points: ${points.length}`);
console.log(`  X: [${Math.min(...points.map(p=>p.x)).toFixed(4)}, ${Math.max(...points.map(p=>p.x)).toFixed(4)}]`);
console.log(`  Y: [${Math.min(...points.map(p=>p.y)).toFixed(4)}, ${Math.max(...points.map(p=>p.y)).toFixed(4)}]`);
console.log(`  Z: [${Math.min(...points.map(p=>p.z)).toFixed(4)}, ${Math.max(...points.map(p=>p.z)).toFixed(4)}]`);

// 7-float origin ranges
const sf7 = geometries.filter(g => g.floats.length === 7);
console.log(`\n7-float entities: ${sf7.length}`);
if (sf7.length > 0) {
    console.log(`  Origin X: [${Math.min(...sf7.map(g=>g.floats[0])).toFixed(6)}, ${Math.max(...sf7.map(g=>g.floats[0])).toFixed(6)}]`);
    console.log(`  Origin Y: [${Math.min(...sf7.map(g=>g.floats[1])).toFixed(6)}, ${Math.max(...sf7.map(g=>g.floats[1])).toFixed(6)}]`);
    console.log(`  Origin Z: [${Math.min(...sf7.map(g=>g.floats[2])).toFixed(6)}, ${Math.max(...sf7.map(g=>g.floats[2])).toFixed(6)}]`);
    console.log(`  Dir mag range: [${Math.min(...sf7.map(g=>Math.sqrt(g.floats[3]**2+g.floats[4]**2+g.floats[5]**2))).toFixed(6)}, ${Math.max(...sf7.map(g=>Math.sqrt(g.floats[3]**2+g.floats[4]**2+g.floats[5]**2))).toFixed(6)}]`);
    console.log(`  Float[6] range: [${Math.min(...sf7.map(g=>g.floats[6])).toFixed(6)}, ${Math.max(...sf7.map(g=>g.floats[6])).toFixed(6)}]`);
}

// ── STEP cross-reference ────────────────────────────────────────────────────

const stepFiles = existsSync(ctcDefDir) ? readdirSync(ctcDefDir).filter(f => /ctc.01/i.test(f) && /\.stp$/i.test(f)) : [];
if (stepFiles.length > 0) {
    const text = readFileSync(join(ctcDefDir, stepFiles[0]), 'utf-8');
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

    const stepPlanes = [];
    for (const m of text.matchAll(/#(\d+)\s*=\s*PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g)) {
        const axis = axes.get(parseInt(m[2]));
        if (!axis) continue;
        const origin = pts.get(axis.loc);
        const normal = dirs.get(axis.z);
        if (origin && normal) stepPlanes.push({ origin, normal });
    }

    const stepCyls = [];
    for (const m of text.matchAll(/#(\d+)\s*=\s*CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([-\d.eE+]+)\s*\)/g)) {
        const axis = axes.get(parseInt(m[2]));
        if (!axis) continue;
        const origin = pts.get(axis.loc);
        const axisDir = dirs.get(axis.z);
        const radius = parseFloat(m[3]);
        if (origin && axisDir) stepCyls.push({ origin, axisDir, radius });
    }

    console.log(`\nScaling: PS points are in meters (range ±0.4), STEP in mm (range ±400)`);
    console.log(`Scale factor: ×1000 (PS→STEP)`);

    // ── Match 7-float entities to STEP planes/lines ────────────────────
    const scales = [1000]; // PS meters → STEP mm
    console.log(`\n=== PLANE MATCHING (scale=1000) ===`);
    let planeMatch = 0;
    const matchedPs = new Set();
    for (const sp of stepPlanes) {
        let bestDist = Infinity, bestG = null;
        for (const pg of sf7) {
            if (matchedPs.has(pg.id)) continue;
            const dx = sp.origin[0] - pg.floats[0] * 1000;
            const dy = sp.origin[1] - pg.floats[1] * 1000;
            const dz = sp.origin[2] - pg.floats[2] * 1000;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (dist < bestDist) { bestDist = dist; bestG = pg; }
        }
        const dot = bestG ? Math.abs(sp.normal[0]*bestG.floats[3] + sp.normal[1]*bestG.floats[4] + sp.normal[2]*bestG.floats[5]) : 0;
        if (bestDist < 1.0 && Math.abs(dot - 1) < 0.05) {
            planeMatch++;
            matchedPs.add(bestG.id);
        }
    }
    console.log(`  Matched: ${planeMatch}/${stepPlanes.length}`);

    // Show first 5 unmatched
    console.log(`\n  First 5 unmatched STEP planes:`);
    let shown = 0;
    for (const sp of stepPlanes) {
        if (shown >= 5) break;
        let bestDist = Infinity, bestG = null;
        for (const pg of sf7) {
            const dx = sp.origin[0] - pg.floats[0] * 1000;
            const dy = sp.origin[1] - pg.floats[1] * 1000;
            const dz = sp.origin[2] - pg.floats[2] * 1000;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (dist < bestDist) { bestDist = dist; bestG = pg; }
        }
        const dot = bestG ? Math.abs(sp.normal[0]*bestG.floats[3] + sp.normal[1]*bestG.floats[4] + sp.normal[2]*bestG.floats[5]) : 0;
        if (bestDist >= 1.0 || Math.abs(dot - 1) >= 0.05) {
            console.log(`    STEP origin=(${sp.origin.map(v=>v.toFixed(2)).join(', ')}) normal=(${sp.normal.map(v=>v.toFixed(4)).join(', ')})`);
            if (bestG) {
                console.log(`      Closest PS id=${bestG.id}: dist=${bestDist.toFixed(2)} dot=${dot.toFixed(4)} origin×1000=(${(bestG.floats[0]*1000).toFixed(2)}, ${(bestG.floats[1]*1000).toFixed(2)}, ${(bestG.floats[2]*1000).toFixed(2)}) dir=(${bestG.floats[3].toFixed(4)}, ${bestG.floats[4].toFixed(4)}, ${bestG.floats[5].toFixed(4)})`);
            }
            shown++;
        }
    }

    // ── Cylinder matching ───────────────────────────────────────────────
    const sf8 = geometries.filter(g => g.floats.length === 8);
    console.log(`\n=== CYLINDER MATCHING (scale=1000, 8-float entities: ${sf8.length}) ===`);
    let cylMatch = 0;
    for (const sc of stepCyls) {
        let found = false;
        for (const pg of sf8) {
            const dx = sc.origin[0] - pg.floats[0] * 1000;
            const dy = sc.origin[1] - pg.floats[1] * 1000;
            const dz = sc.origin[2] - pg.floats[2] * 1000;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            const dot = Math.abs(sc.axisDir[0]*pg.floats[3] + sc.axisDir[1]*pg.floats[4] + sc.axisDir[2]*pg.floats[5]);
            const rDiff = Math.abs(sc.radius - pg.floats[7] * 1000);
            if (dist < 1.0 && Math.abs(dot - 1) < 0.05 && rDiff < 1.0) { found = true; break; }
        }
        if (found) cylMatch++;
    }
    console.log(`  Matched: ${cylMatch}/${stepCyls.length}`);

    // Also try matching cylinders to 10+ float entities
    const sf10 = geometries.filter(g => g.floats.length >= 10);
    console.log(`\n  10+-float entities: ${sf10.length}`);
    let cyl10Match = 0;
    for (const sc of stepCyls) {
        let found = false;
        for (const pg of sf10) {
            const dx = sc.origin[0] - pg.floats[0] * 1000;
            const dy = sc.origin[1] - pg.floats[1] * 1000;
            const dz = sc.origin[2] - pg.floats[2] * 1000;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            const dot = Math.abs(sc.axisDir[0]*pg.floats[3] + sc.axisDir[1]*pg.floats[4] + sc.axisDir[2]*pg.floats[5]);
            // Try last float as radius, also try float[9] and float[10]
            let rMatch = false;
            for (let ri = 6; ri < pg.floats.length; ri++) {
                if (Math.abs(sc.radius - pg.floats[ri] * 1000) < 1.0) { rMatch = true; break; }
            }
            if (dist < 1.0 && Math.abs(dot - 1) < 0.05 && rMatch) { found = true; break; }
        }
        if (found) cyl10Match++;
    }
    console.log(`  Cylinders matched via 10+-float: ${cyl10Match}/${stepCyls.length}`);

    // Show sample 8 and 10+ float entities
    console.log(`\n  Sample 8-float entities:`);
    for (const g of sf8.slice(0, 3)) {
        console.log(`    id=${g.id} floats×1000=[${g.floats.map(f=>(f*1000).toFixed(2)).join(', ')}]`);
    }
    console.log(`\n  Sample 10+-float entities (first 5):`);
    for (const g of sf10.slice(0, 5)) {
        console.log(`    id=${g.id} #floats=${g.floats.length} origin×1000=(${(g.floats[0]*1000).toFixed(2)}, ${(g.floats[1]*1000).toFixed(2)}, ${(g.floats[2]*1000).toFixed(2)}) axis=(${g.floats[3].toFixed(4)}, ${g.floats[4].toFixed(4)}, ${g.floats[5].toFixed(4)}) rest=[${g.floats.slice(6).map(f=>(f*1000).toFixed(4)).join(', ')}]`);
    }
}
