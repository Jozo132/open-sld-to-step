/**
 * investigate27.mjs — Confirm sentinel-based entity structure across ALL 11 NIST files.
 * Fuzzy coordinate matching (allow ±16 ULP drift) and entity type census.
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');
const ctcDefDir = join(stpDir, 'CTC Definitions');
const ftcDefDir = join(stpDir, 'FTC Definitions');

const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);

function isParasolid(buf) {
    return buf.length >= 20 && buf[0] === 0x50 && buf[1] === 0x53 &&
           buf.indexOf('TRANSMIT', 0, 'ascii') >= 0 && buf.indexOf('TRANSMIT', 0, 'ascii') < 32;
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
                        try { const n = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 }); if (isParasolid(n) && (!best || n.length > best.length)) best = n; } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

/** Parse STEP file for CARTESIAN_POINT, DIRECTION, VERTEX_POINT, etc. */
function parseStepFile(path) {
    const text = readFileSync(path, 'utf-8');
    const points = new Map();  // id → [x,y,z]
    const verts = [];  // {id, pointId}
    let unit = 'mm';
    
    // Detect units
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) unit = 'inch';
    
    // Parse CARTESIAN_POINT
    const cpRe = /#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)\s*\)/g;
    let m;
    while ((m = cpRe.exec(text))) {
        points.set(parseInt(m[1]), [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])]);
    }
    
    // Parse VERTEX_POINT
    const vpRe = /#(\d+)\s*=\s*VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g;
    while ((m = vpRe.exec(text))) {
        verts.push({ id: parseInt(m[1]), pointId: parseInt(m[2]) });
    }
    
    return { points, verts, unit };
}

/** Split PS buffer into entity records using sentinel */
function splitEntities(ps) {
    const entities = [];
    let idx = 0;
    const positions = [];
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) {
        positions.push(idx);
        idx++;
    }
    
    for (let i = 0; i < positions.length; i++) {
        const start = positions[i];
        const end = (i + 1 < positions.length) ? positions[i + 1] : ps.length;
        const recordStart = start + 6; // skip sentinel
        const recordLen = end - recordStart;
        if (recordLen < 4) continue;
        
        // Parse header: [00 00 00 03] [00 type] [id:2] [00 00] [ref:2] [00 01] [refs...]
        const headerByte = ps[recordStart];
        if (headerByte !== 0x00) continue;
        
        // Check for 00 00 00 03 pattern
        if (recordStart + 6 > ps.length) continue;
        const word = ps.readUInt32BE(recordStart);
        
        let type, id, dataOffset;
        if (word === 0x00000003) {
            type = ps.readUInt16BE(recordStart + 4);
            id = ps.readUInt16BE(recordStart + 6);
            dataOffset = recordStart + 8;
        } else {
            // Try other header patterns
            continue;
        }
        
        entities.push({
            sentinelPos: start,
            type,
            id,
            dataOffset,
            data: ps.subarray(dataOffset, end),
            fullRecord: ps.subarray(recordStart, end)
        });
    }
    return entities;
}

/** Fuzzy match: check if two float64 values are within ±N ULP */
function fuzzyMatchFloat(a, b, maxULP = 64) {
    if (a === b) return true;
    if (Math.abs(a) < 1e-15 && Math.abs(b) < 1e-15) return true;
    const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
    return rel < 1e-10;
}

const models = [
    { sld: 'nist_ctc_01_asme1_rd_sw1802.SLDPRT', stp: join(ctcDefDir, 'nist_ctc_01_asme1_rd.stp'), name: 'ctc_01' },
    { sld: 'nist_ctc_02_asme1_rc_sw1802.SLDPRT', stp: join(ctcDefDir, 'nist_ctc_02_asme1_rc.stp'), name: 'ctc_02' },
    { sld: 'nist_ctc_03_asme1_rc_sw1802.SLDPRT', stp: join(ctcDefDir, 'nist_ctc_03_asme1_rc.stp'), name: 'ctc_03' },
    { sld: 'nist_ctc_04_asme1_rd_sw1802.SLDPRT', stp: join(ctcDefDir, 'nist_ctc_04_asme1_rd.stp'), name: 'ctc_04' },
    { sld: 'nist_ctc_05_asme1_rd_sw1802.SLDPRT', stp: join(ctcDefDir, 'nist_ctc_05_asme1_rd.stp'), name: 'ctc_05' },
    { sld: 'nist_ftc_06_asme1_rd_sw1802.SLDPRT', stp: join(ftcDefDir, 'nist_ftc_06_asme1_rd.stp'), name: 'ftc_06' },
    { sld: 'nist_ftc_07_asme1_rd_sw1802.SLDPRT', stp: join(ftcDefDir, 'nist_ftc_07_asme1_rd.stp'), name: 'ftc_07' },
    { sld: 'nist_ftc_08_asme1_rc_sw1802.SLDPRT', stp: join(ftcDefDir, 'nist_ftc_08_asme1_rc.stp'), name: 'ftc_08' },
    { sld: 'nist_ftc_09_asme1_rd_sw1802.SLDPRT', stp: join(ftcDefDir, 'nist_ftc_09_asme1_rd.stp'), name: 'ftc_09' },
    { sld: 'nist_ftc_10_asme1_rb_sw1802.SLDPRT', stp: join(ftcDefDir, 'nist_ftc_10_asme1_rb.stp'), name: 'ftc_10' },
    { sld: 'nist_ftc_11_asme1_rb_sw1802.SLDPRT', stp: join(ftcDefDir, 'nist_ftc_11_asme1_rb.stp'), name: 'ftc_11' },
];

const output = [];
function log(s = '') { output.push(s); console.log(s); }

for (const model of models) {
    log(`\n${'='.repeat(70)}`);
    log(`MODEL: ${model.name}`);
    log(`${'='.repeat(70)}`);
    
    let ps;
    try { ps = getLargestPS(join(sldDir, model.sld)); } catch (e) { log(`  SKIP: ${e.message}`); continue; }
    if (!ps) { log(`  SKIP: no PS found`); continue; }
    
    let step;
    try { step = parseStepFile(model.stp); } catch (e) { log(`  SKIP STEP: ${e.message}`); continue; }
    
    log(`  PS buffer: ${ps.length} bytes`);
    log(`  STEP unit: ${step.unit}`);
    log(`  STEP vertices: ${step.verts.length}`);
    log(`  STEP cartesian_points: ${step.points.size}`);
    
    // Count sentinels
    let sentCount = 0, idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentCount++; idx++; }
    log(`  Sentinels: ${sentCount}`);
    
    // Split into entities and census by type
    const entities = splitEntities(ps);
    log(`  Parsed entities: ${entities.length}`);
    
    const typeCounts = new Map();
    for (const e of entities) {
        typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    }
    const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
    log(`  Entity types:`);
    for (const [type, count] of sorted) {
        log(`    type 0x${type.toString(16).padStart(2, '0')} (${type}): ${count}`);
    }
    
    // For type-0x1D entities, extract coordinates and match to STEP vertices
    const type1d = entities.filter(e => e.type === 0x1d);
    log(`\n  Type-0x1D (point) entities: ${type1d.length}`);
    
    // Scale factor: STEP → PS (meters)
    const scale = step.unit === 'inch' ? 0.0254 : 0.001;
    
    // Extract coordinates from type-0x1D records
    // Structure: [00 00] [ref:2] [00 01] [ref1:2] [ref2:2] [ref3:2] [x:8] [y:8] [z:8]
    // That's 14 bytes header after dataOffset, then 24 bytes coords
    const psCoords = [];
    for (const e of type1d) {
        if (e.data.length >= 38) {
            // dataOffset is after [00 type:2 id:2], so data starts at the field bytes
            // Typical: [00 00] [ref:2] [00 01] [ref1:2] [ref2:2] [ref3:2] [x:8] [y:8] [z:8]
            // That's offset 0: 00 00, +2: ref, +4: 00 01, +6: ref1, +8: ref2, +10: ref3, +12: x
            const coordOff = 12;
            if (e.data.length >= coordOff + 24) {
                const x = e.data.readDoubleBE(coordOff);
                const y = e.data.readDoubleBE(coordOff + 8);
                const z = e.data.readDoubleBE(coordOff + 16);
                if (isFinite(x) && isFinite(y) && isFinite(z) &&
                    Math.abs(x) < 100 && Math.abs(y) < 100 && Math.abs(z) < 100) {
                    psCoords.push({ id: e.id, x, y, z });
                }
            }
        }
    }
    log(`  Extracted PS coordinates: ${psCoords.length}`);
    
    // For each STEP vertex, find best matching PS point
    let matched = 0, unmatched = 0;
    const unmatchedVerts = [];
    for (const sv of step.verts) {
        const sp = step.points.get(sv.pointId);
        if (!sp) continue;
        const [sx, sy, sz] = sp;
        // Convert STEP coords to meters
        const mx = sx * scale, my = sy * scale, mz = sz * scale;
        
        let found = false;
        for (const pc of psCoords) {
            if (fuzzyMatchFloat(pc.x, mx) && fuzzyMatchFloat(pc.y, my) && fuzzyMatchFloat(pc.z, mz)) {
                found = true;
                matched++;
                break;
            }
        }
        if (!found) {
            unmatched++;
            if (unmatchedVerts.length < 5) {
                unmatchedVerts.push(`    #${sv.id} (${sx}, ${sy}, ${sz}) ${step.unit} → (${mx}, ${my}, ${mz}) m`);
            }
        }
    }
    log(`  Vertex match: ${matched}/${step.verts.length} (${(100 * matched / step.verts.length).toFixed(1)}%)`);
    if (unmatched > 0) {
        log(`  Unmatched: ${unmatched}`);
        for (const u of unmatchedVerts) log(u);
        if (unmatched > 5) log(`    ... and ${unmatched - 5} more`);
    }
    
    // Also check: how many type-0x1D records have reasonable coordinates?
    let reasonableCoords = 0;
    for (const pc of psCoords) {
        if (Math.abs(pc.x) < 10 && Math.abs(pc.y) < 10 && Math.abs(pc.z) < 10) reasonableCoords++;
    }
    log(`  PS coords in reasonable range (<10m): ${reasonableCoords}`);
}

// Also check: are there type-0x1D records with different header patterns?
log(`\n\n${'='.repeat(70)}`);
log(`DEEP TYPE-0x1D HEADER ANALYSIS (ctc_01 and ctc_03)`);
log(`${'='.repeat(70)}\n`);

for (const modelName of ['ctc_01', 'ctc_03']) {
    const model = models.find(m => m.name === modelName);
    const ps = getLargestPS(join(sldDir, model.sld));
    const entities = splitEntities(ps);
    const type1d = entities.filter(e => e.type === 0x1d);
    
    log(`${modelName}: ${type1d.length} type-0x1d entities`);
    
    // Show first 5 records hex to compare structure
    for (const e of type1d.slice(0, 5)) {
        const hexStr = [...e.fullRecord.subarray(0, Math.min(48, e.fullRecord.length))]
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        // Decode fields
        const ref0 = e.data.readUInt16BE(2);
        const marker = e.data.readUInt16BE(4);
        const ref1 = e.data.readUInt16BE(6);
        const ref2 = e.data.readUInt16BE(8);
        const ref3 = e.data.readUInt16BE(10);
        const x = e.data.length >= 20 ? e.data.readDoubleBE(12) : NaN;
        const y = e.data.length >= 28 ? e.data.readDoubleBE(20) : NaN;
        const z = e.data.length >= 36 ? e.data.readDoubleBE(28) : NaN;
        log(`  id=${e.id} ref0=${ref0} marker=0x${marker.toString(16)} refs=[${ref1},${ref2},${ref3}] coords=(${x.toFixed(6)}, ${y.toFixed(6)}, ${z.toFixed(6)})`);
        log(`    ${hexStr}`);
    }
    log('');
}

writeFileSync('inv27-output.txt', output.join('\n'));
