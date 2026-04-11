/**
 * investigate23.mjs — Reverse lookup: find STEP vertex coordinates
 * in the Parasolid binary to determine exact entity record encoding.
 *
 * For each STEP VERTEX_POINT coordinate, we:
 * 1. Convert mm→meters (÷1000) or mm→inches→meters (÷25.4÷1000)
 * 2. Write as float64 BE bytes
 * 3. Search for that exact 8-byte sequence in the PS buffer
 * 4. Analyze surrounding bytes to understand record structure
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');

// ── Helpers ─────────────────────────────────────────────────────────────────

const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

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

function parseStepVertices(filePath) {
    const text = readFileSync(filePath, 'utf8');
    const joined = text.replace(/\r\n/g, '\n').replace(/\n(?!#)/g, '');
    const entities = new Map();
    const re = /#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([^;]*)\)\s*;/g;
    let m;
    while ((m = re.exec(joined)) !== null) {
        entities.set(parseInt(m[1]), { type: m[2], args: m[3].trim() });
    }

    const points = new Map();
    for (const [id, ent] of entities) {
        if (ent.type === 'CARTESIAN_POINT') {
            const match = ent.args.match(/\(([^)]+)\)/);
            if (match) {
                const coords = match[1].split(',').map(Number);
                if (coords.length >= 3 && coords.every(isFinite)) {
                    points.set(id, { x: coords[0], y: coords[1], z: coords[2] });
                }
            }
        }
    }

    const vertices = [];
    for (const [id, ent] of entities) {
        if (ent.type === 'VERTEX_POINT') {
            const refs = [...ent.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
            const ptId = refs[refs.length - 1];
            const pt = points.get(ptId);
            if (pt) vertices.push({ id, pointId: ptId, ...pt });
        }
    }

    // Also get surface/curve info
    const surfaces = [];
    for (const [id, ent] of entities) {
        if (/PLANE|CYLINDRICAL_SURFACE|CONICAL_SURFACE|SPHERICAL_SURFACE|TOROIDAL_SURFACE|B_SPLINE_SURFACE/.test(ent.type)) {
            const refs = [...ent.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
            // Get the AXIS2_PLACEMENT_3D ref (first ref)
            const apId = refs[0];
            const ap = entities.get(apId);
            let origin = null;
            if (ap && ap.type === 'AXIS2_PLACEMENT_3D') {
                const apRefs = [...ap.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
                origin = points.get(apRefs[0]);
            }

            // Get radius for cylindrical/conical etc.
            const numMatch = ent.args.match(/,\s*([\d.eE+-]+)\s*[,)]/);
            const radius = numMatch ? parseFloat(numMatch[1]) : null;

            surfaces.push({ id, type: ent.type, origin, radius });
        }
    }

    return { vertices, points, surfaces, entities };
}

function float64BEbytes(val) {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(val);
    return buf;
}

function findFloat64InBuffer(psBuf, val) {
    const needle = float64BEbytes(val);
    const positions = [];
    let idx = 0;
    while (idx < psBuf.length - 7) {
        idx = psBuf.indexOf(needle, idx);
        if (idx < 0) break;
        positions.push(idx);
        idx++;
    }
    return positions;
}

function hexDump(buf, offset, len) {
    const start = Math.max(0, offset);
    const end = Math.min(buf.length, offset + len);
    const lines = [];
    for (let off = start; off < end; off += 32) {
        const slice = buf.subarray(off, Math.min(off + 32, end));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        lines.push(`  ${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
    return lines.join('\n');
}

// ── Main: CTC_01 (has =p/=q markers, scale ÷1000) ─────────────────────────

console.log('═'.repeat(80));
console.log('MODEL: ctc_01 (markers, mm→m = ÷1000)');
console.log('═'.repeat(80));

const step01 = parseStepVertices(join(stpDir, 'CTC Definitions', 'nist_ctc_01_asme1_rd.stp'));
const ps01 = getLargestPS(join(sldDir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));

console.log(`STEP vertices: ${step01.vertices.length}, PS buffer: ${ps01.length} bytes`);
console.log(`STEP surfaces: ${step01.surfaces.length}`);

// Find =p/=q markers
const markers01 = [];
for (let i = 0; i < ps01.length - 1; i++) {
    if (ps01[i] === 0x3d && (ps01[i + 1] === 0x70 || ps01[i + 1] === 0x71))
        markers01.push(i);
}
console.log(`PS markers: ${markers01.length}\n`);

// Search for each STEP vertex coordinate (converted to meters) in the PS buffer
console.log('=== VERTEX COORDINATE LOCATIONS IN PS BUFFER ===\n');
const foundVertices01 = [];
for (const v of step01.vertices.slice(0, 30)) {
    // Convert mm to meters
    const mx = v.x / 1000, my = v.y / 1000, mz = v.z / 1000;
    
    // Search for each coordinate individually
    const xPos = findFloat64InBuffer(ps01, mx);
    const yPos = findFloat64InBuffer(ps01, my);
    const zPos = findFloat64InBuffer(ps01, mz);
    
    // Find where all three appear as consecutive triplet (x @n, y @n+8, z @n+16)
    const triplets = [];
    for (const xp of xPos) {
        if (yPos.includes(xp + 8) && zPos.includes(xp + 16)) {
            triplets.push(xp);
        }
    }
    
    if (triplets.length > 0) {
        foundVertices01.push({ vertex: v, offsets: triplets });
        const off = triplets[0];
        // Find which marker this belongs to
        let markerIdx = -1;
        for (let i = markers01.length - 1; i >= 0; i--) {
            if (markers01[i] <= off) { markerIdx = i; break; }
        }
        const markerOff = markerIdx >= 0 ? markers01[markerIdx] : -1;
        const markerType = markerOff >= 0 ? (ps01[markerOff + 1] === 0x70 ? '=p' : '=q') : '??';
        const relOff = markerOff >= 0 ? off - markerOff : -1;
        console.log(`  STEP #${v.id} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) mm`);
        console.log(`    → PS @0x${off.toString(16)} (${markerType} @0x${markerOff.toString(16)}, +${relOff} bytes into record)`);
        // Show 16 bytes before and 32 bytes after the triplet
        console.log(hexDump(ps01, off - 16, 56));
        console.log('');
    } else {
        // Show individual coord hits
        if (xPos.length > 0 || yPos.length > 0 || zPos.length > 0) {
            console.log(`  STEP #${v.id} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) mm — NO TRIPLET`);
            console.log(`    x hits: ${xPos.length} at ${xPos.slice(0, 3).map(p => '0x' + p.toString(16)).join(', ')}`);
            console.log(`    y hits: ${yPos.length} at ${yPos.slice(0, 3).map(p => '0x' + p.toString(16)).join(', ')}`);
            console.log(`    z hits: ${zPos.length} at ${zPos.slice(0, 3).map(p => '0x' + p.toString(16)).join(', ')}`);
            console.log('');
        }
    }
}
console.log(`Found ${foundVertices01.length} / ${Math.min(30, step01.vertices.length)} vertices as triplets\n`);

// Analyze the offsets-within-record patterns
if (foundVertices01.length > 2) {
    console.log('=== RECORD OFFSET PATTERNS ===\n');
    const offsets = foundVertices01.map(fv => {
        const off = fv.offsets[0];
        let markerIdx = -1;
        for (let i = markers01.length - 1; i >= 0; i--) {
            if (markers01[i] <= off) { markerIdx = i; break; }
        }
        const mOff = markers01[markerIdx];
        return { off, marker: mOff, rel: off - mOff, type: ps01[mOff + 1] === 0x70 ? 'p' : 'q' };
    });
    
    console.log('Offset from marker:');
    const relCounts = {};
    for (const o of offsets) {
        const key = `=${o.type}+${o.rel}`;
        relCounts[key] = (relCounts[key] || 0) + 1;
    }
    for (const [k, v] of Object.entries(relCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${v} times`);
    }
}

// ── CTC_03 (markerless, scale likely ÷25.4 then ÷1000 = inches to meters) ──

console.log('\n' + '═'.repeat(80));
console.log('MODEL: ctc_03 (NO markers, units in inches? or mm?)');
console.log('═'.repeat(80));

const step03 = parseStepVertices(join(stpDir, 'CTC Definitions', 'nist_ctc_03_asme1_rc.stp'));
const ps03 = getLargestPS(join(sldDir, 'nist_ctc_03_asme1_rc_sw1802.SLDPRT'));

console.log(`STEP vertices: ${step03.vertices.length}, PS buffer: ${ps03.length} bytes`);

// Try different scale factors
console.log('\n=== SCALE FACTOR DETECTION ===\n');
const testVertex = step03.vertices[0]; // (-9.5, 0.5, 0.0) mm
console.log(`Test vertex: STEP #${testVertex.id} = (${testVertex.x}, ${testVertex.y}, ${testVertex.z}) mm`);

for (const [label, scale] of [
    ['mm (÷1)', 1], ['m (÷1000)', 1000], ['inches (÷25.4)', 25.4], ['m-from-in (÷25400)', 25400]
]) {
    const mx = testVertex.x / scale, my = testVertex.y / scale, mz = testVertex.z / scale;
    const xHits = findFloat64InBuffer(ps03, mx);
    const yHits = findFloat64InBuffer(ps03, my);
    const zHits = findFloat64InBuffer(ps03, mz);

    // Check triplets
    let triplets = 0;
    for (const xp of xHits) {
        if (yHits.includes(xp + 8) && zHits.includes(xp + 16)) triplets++;
    }

    console.log(`  ${label}: val=(${mx.toFixed(6)}, ${my.toFixed(6)}, ${mz.toFixed(6)}) → x:${xHits.length} y:${yHits.length} z:${zHits.length} triplets:${triplets}`);
}

// Try all step vertices with all scale factors to find the one that works
console.log('\n=== BULK SCALE TEST (all vertices) ===\n');
for (const [label, scale] of [
    ['÷1 (raw mm)', 1], ['÷1000 (m)', 1000], ['÷25.4 (in)', 25.4], ['÷25400 (m-from-in)', 25400]
]) {
    let tripletCount = 0;
    for (const v of step03.vertices) {
        const mx = v.x / scale, my = v.y / scale, mz = v.z / scale;
        const xHits = findFloat64InBuffer(ps03, mx);
        for (const xp of xHits) {
            const yNeedle = float64BEbytes(my);
            const zNeedle = float64BEbytes(mz);
            if (xp + 24 <= ps03.length &&
                ps03.subarray(xp + 8, xp + 16).equals(yNeedle) &&
                ps03.subarray(xp + 16, xp + 24).equals(zNeedle)) {
                tripletCount++;
                break; // count each vertex once
            }
        }
    }
    console.log(`  ${label}: ${tripletCount} / ${step03.vertices.length} vertices found as triplets`);
}

// Now find the actual vertex locations with the winning scale
const bestScale03 = (() => {
    let best = 1, bestCount = 0;
    for (const scale of [1, 1000, 25.4, 25400]) {
        let count = 0;
        for (const v of step03.vertices) {
            const mx = v.x / scale, my = v.y / scale, mz = v.z / scale;
            const xHits = findFloat64InBuffer(ps03, mx);
            for (const xp of xHits) {
                if (xp + 24 <= ps03.length &&
                    ps03.subarray(xp + 8, xp + 16).equals(float64BEbytes(my)) &&
                    ps03.subarray(xp + 16, xp + 24).equals(float64BEbytes(mz))) {
                    count++; break;
                }
            }
        }
        if (count > bestCount) { bestCount = count; best = scale; }
    }
    return best;
})();
console.log(`\nBest scale: ÷${bestScale03}`);

console.log('\n=== VERTEX LOCATIONS (ctc_03) ===\n');
const foundVertices03 = [];
for (const v of step03.vertices.slice(0, 30)) {
    const mx = v.x / bestScale03, my = v.y / bestScale03, mz = v.z / bestScale03;
    const xPos = findFloat64InBuffer(ps03, mx);
    for (const xp of xPos) {
        if (xp + 24 <= ps03.length &&
            ps03.subarray(xp + 8, xp + 16).equals(float64BEbytes(my)) &&
            ps03.subarray(xp + 16, xp + 24).equals(float64BEbytes(mz))) {
            foundVertices03.push({ vertex: v, offset: xp });
            console.log(`  STEP #${v.id} (${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}) mm → PS @0x${xp.toString(16)}`);
            console.log(hexDump(ps03, xp - 24, 72));
            console.log('');
            break;
        }
    }
}
console.log(`Found ${foundVertices03.length} / ${Math.min(30, step03.vertices.length)} vertices\n`);

// If we found vertices, analyze the bytes between consecutive vertex locations
if (foundVertices03.length > 3) {
    foundVertices03.sort((a, b) => a.offset - b.offset);
    console.log('=== INTER-VERTEX GAPS ===\n');
    for (let i = 0; i < Math.min(10, foundVertices03.length - 1); i++) {
        const curr = foundVertices03[i];
        const next = foundVertices03[i + 1];
        const gap = next.offset - (curr.offset + 24); // 24 = 3×float64
        console.log(`  #${curr.vertex.id} @0x${curr.offset.toString(16)} → #${next.vertex.id} @0x${next.offset.toString(16)} : gap = ${gap} bytes`);
        if (gap > 0 && gap < 200) {
            const gapBuf = ps03.subarray(curr.offset + 24, next.offset);
            console.log(hexDump(ps03, curr.offset + 24, gap));
        }
        console.log('');
    }
}

// ── Also search for surface origins (AXIS2_PLACEMENT_3D locations) ──────────

console.log('\n=== SURFACE ORIGIN LOCATIONS (ctc_01) ===\n');
let surfFound = 0;
for (const s of step01.surfaces.slice(0, 15)) {
    if (!s.origin) continue;
    const mx = s.origin.x / 1000, my = s.origin.y / 1000, mz = s.origin.z / 1000;
    const xPos = findFloat64InBuffer(ps01, mx);
    for (const xp of xPos) {
        if (xp + 24 <= ps01.length &&
            ps01.subarray(xp + 8, xp + 16).equals(float64BEbytes(my)) &&
            ps01.subarray(xp + 16, xp + 24).equals(float64BEbytes(mz))) {
            let markerIdx = -1;
            for (let i = markers01.length - 1; i >= 0; i--) {
                if (markers01[i] <= xp) { markerIdx = i; break; }
            }
            const mOff = markerIdx >= 0 ? markers01[markerIdx] : -1;
            const mType = mOff >= 0 ? (ps01[mOff + 1] === 0x70 ? '=p' : '=q') : '??';
            surfFound++;
            console.log(`  ${s.type} #${s.id} origin=(${s.origin.x.toFixed(2)}, ${s.origin.y.toFixed(2)}, ${s.origin.z.toFixed(2)}) mm`);
            console.log(`    → PS @0x${xp.toString(16)} (${mType} @0x${mOff.toString(16)}, +${xp - mOff} bytes)`);
            if (s.radius) console.log(`    radius=${s.radius}mm`);
            console.log(hexDump(ps01, xp - 16, 64));
            console.log('');
            break;
        }
    }
}
console.log(`Found ${surfFound} surface origins\n`);
