/**
 * investigate26.mjs — Find individual coordinate values in ctc_03 markerless PS buffer
 * and analyze what surrounds them to understand the record structure.
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
function isParasolid(buf) { return buf.length >= 20 && buf[0] === 0x50 && buf[1] === 0x53 && buf.indexOf('TRANSMIT', 0, 'ascii') >= 0 && buf.indexOf('TRANSMIT', 0, 'ascii') < 32; }
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
function float64BEbytes(val) { const b = Buffer.alloc(8); b.writeDoubleBE(val); return b; }

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

const ps = getLargestPS(join(sldDir, 'nist_ctc_03_asme1_rc_sw1802.SLDPRT'));
console.log(`PS buffer: ${ps.length} bytes\n`);

// STEP vertex #1541 = (-9.5, 0.5, 0.0) inches
// PS values should be: x=-0.2413, y=0.0127, z=0.0 (meters)
const vx = -9.5 * 0.0254;   // -0.2413
const vy = 0.5 * 0.0254;    // 0.0127
const vz = 0.0 * 0.0254;    // 0.0

console.log(`Searching for vertex (-9.5, 0.5, 0.0) inches = (${vx}, ${vy}, ${vz}) meters\n`);

// Find all x-value positions
const xNeedle = float64BEbytes(vx);
const yNeedle = float64BEbytes(vy);
const zNeedle = float64BEbytes(vz);

let xPositions = [], yPositions = [];
let idx = 0;
while ((idx = ps.indexOf(xNeedle, idx)) >= 0) { xPositions.push(idx); idx++; }
idx = 0;
while ((idx = ps.indexOf(yNeedle, idx)) >= 0) { yPositions.push(idx); idx++; }

console.log(`x=-0.2413 found at ${xPositions.length} positions: ${xPositions.map(p => '0x' + p.toString(16)).join(', ')}`);
console.log(`y=0.0127 found at ${yPositions.length} positions: ${yPositions.map(p => '0x' + p.toString(16)).join(', ')}`);
console.log(`z=0.0 is trivial (matches 0x0000000000000000)\n`);

// For each x position, show what's at +8 (expected y), +16 (expected z), and context
console.log('=== CONTEXT AROUND X POSITIONS ===\n');
for (const xp of xPositions.slice(0, 8)) {
    const yAtPlus8 = xp + 8 < ps.length - 7 ? ps.readDoubleBE(xp + 8) : NaN;
    const zAtPlus16 = xp + 16 < ps.length - 7 ? ps.readDoubleBE(xp + 16) : NaN;
    
    console.log(`x=-0.2413 @0x${xp.toString(16)}:`);
    console.log(`  at +8:  ${yAtPlus8} (expected ${vy})`);
    console.log(`  at +16: ${zAtPlus16} (expected ${vz})`);
    console.log(hexDump(ps, xp - 32, 96));

    // Check if y is somewhere nearby (within 64 bytes)
    const yDist = yPositions.map(yp => ({ yp, dist: yp - xp })).filter(({ dist }) => dist > 0 && dist <= 64);
    if (yDist.length > 0) {
        console.log(`  y=0.0127 found nearby: ${yDist.map(({ yp, dist }) => `@0x${yp.toString(16)} (+${dist})`).join(', ')}`);
    }
    console.log('');
}

// Also check: what's at the y positions?
console.log('\n=== CONTEXT AROUND Y POSITIONS ===\n');
for (const yp of yPositions.slice(0, 5)) {
    const xBefore = yp >= 8 ? ps.readDoubleBE(yp - 8) : NaN;
    const zAfter = yp + 8 < ps.length - 7 ? ps.readDoubleBE(yp + 8) : NaN;
    console.log(`y=0.0127 @0x${yp.toString(16)}: x@-8=${xBefore}, z@+8=${zAfter}`);
    console.log(hexDump(ps, yp - 16, 64));
    console.log('');
}

// Search for second vertex: (-9.5, 1.7118, 0.0) inches
// x = -0.2413 (same), y = 1.7118 × 0.0254 = 0.04347972 
const vy2 = 1.7118 * 0.0254;
console.log(`\n=== Second vertex: y=${vy2} (1.7118 × 0.0254) ===\n`);
const y2Needle = float64BEbytes(vy2);
idx = 0;
let y2Positions = [];
while ((idx = ps.indexOf(y2Needle, idx)) >= 0) { y2Positions.push(idx); idx++; }
console.log(`y2=${vy2} found at ${y2Positions.length} positions: ${y2Positions.map(p => '0x' + p.toString(16)).join(', ')}`);

// For unique vertex values, try to find them individually
console.log('\n\n=== INDIVIDUAL COORDINATE SEARCH (STEP vertex values in inches→meters) ===\n');
// Using ctc_03 STEP vertices
const stepVerts = [
    { id: 1541, x: -9.5, y: 0.5, z: 0.0 },
    { id: 1542, x: -9.5, y: 1.7118, z: 0.0 },
    { id: 1544, x: -9.5, y: 0.5, z: 0.0751 },
    { id: 1546, x: -9.5, y: 1.7118, z: 0.0751 },
    { id: 1548, x: -9.5, y: 1.9618, z: 0.3251 },
    { id: 1550, x: -9.5, y: 1.9618, z: 2.255 },
    { id: 1556, x: -9.5, y: 18.612, z: 0.0751 },
    { id: 1560, x: -9.5, y: 17.3620, z: 0.0751 },
    { id: 1575, x: -9.325, y: 0.500, z: 6.405 },
];

for (const sv of stepVerts) {
    const mx = sv.x * 0.0254, my = sv.y * 0.0254, mz = sv.z * 0.0254;
    const xHits = [], yHits = [], zHits = [];
    const xN = float64BEbytes(mx), yN = float64BEbytes(my), zN = float64BEbytes(mz);
    idx = 0; while ((idx = ps.indexOf(xN, idx)) >= 0) { xHits.push(idx); idx++; }
    idx = 0; while ((idx = ps.indexOf(yN, idx)) >= 0) { yHits.push(idx); idx++; }
    idx = 0; while ((idx = ps.indexOf(zN, idx)) >= 0) { zHits.push(idx); idx++; }

    // Check for triplets at any distance between x,y,z
    let foundTriplet = false;
    for (const xp of xHits) {
        for (const yp of yHits) {
            if (yp <= xp) continue;
            const gap1 = yp - xp;
            if (gap1 > 128) continue;
            for (const zp of zHits) {
                if (zp <= yp) continue;
                const gap2 = zp - yp;
                if (gap2 > 128) continue;
                console.log(`  #${sv.id} (${sv.x}, ${sv.y}, ${sv.z}) in → x@0x${xp.toString(16)} y@0x${yp.toString(16)} z@0x${zp.toString(16)} (gaps: ${gap1}, ${gap2})`);
                foundTriplet = true;
                break;
            }
            if (foundTriplet) break;
        }
        if (foundTriplet) break;
    }
    if (!foundTriplet) {
        console.log(`  #${sv.id} (${sv.x}, ${sv.y}, ${sv.z}) in → x:${xHits.length} y:${yHits.length} z:${zHits.length} ${xHits.length > 0 ? 'x@' + xHits.slice(0, 3).map(p => '0x' + p.toString(16)).join(',') : ''}`);
    }
}

// Compare with ctc_01 sentinel pattern
console.log('\n\n=== SENTINEL SEARCH IN ctc_03 ===\n');
const sentinel = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
let sentCount = 0;
idx = 0;
while ((idx = ps.indexOf(sentinel, idx)) >= 0) { sentCount++; idx++; }
console.log(`ctc_01 sentinel (c2 bc 92 8f 99 6e): ${sentCount} in ctc_03`);

// Look for other repeating patterns that could be record separators
console.log('\n=== REPEATING 4+ BYTE PATTERNS IN DATA AREA ===\n');
const dataStart = 0xa00; // after schema/class defs
const patternCounts = new Map();
for (let i = dataStart; i < ps.length - 6; i++) {
    // Check 6-byte patterns
    const key = ps.subarray(i, i + 6).toString('hex');
    patternCounts.set(key, (patternCounts.get(key) || 0) + 1);
}
const topPatterns = [...patternCounts.entries()].filter(([, c]) => c >= 50).sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log('Top 6-byte patterns (≥50 occurrences):');
for (const [hex, count] of topPatterns) {
    const bytes = hex.match(/.{2}/g).join(' ');
    console.log(`  ${bytes}: ${count} times`);
}

// Also check if the ctc_03 buffer has a different struct with type bytes before coordinates
// In ctc_01, entity records start with [00 type_byte id_hi id_lo]
// Let's search for [00 1d XX XX] patterns near x-value positions
console.log('\n=== TYPE-0x1D SEARCH NEAR X POSITIONS ===\n');
for (const xp of xPositions.slice(0, 5)) {
    // Look back up to 32 bytes for 00 1d pattern
    for (let backOff = 2; backOff <= 32 && xp - backOff >= 0; backOff++) {
        if (ps[xp - backOff] === 0x00 && ps[xp - backOff + 1] === 0x1d) {
            const id = ps.readUInt16BE(xp - backOff + 2);
            console.log(`  x@0x${xp.toString(16)}: found 00 1d at -${backOff} (id=${id})`);
            console.log(hexDump(ps, xp - backOff, 48));
            break;
        }
    }
}

// Finally, check raw structure at the first x position  
console.log('\n=== RAW STRUCTURE AT FIRST X POSITION ===\n');
if (xPositions.length > 0) {
    const xp = xPositions[0];
    console.log(`First x=-0.2413 @0x${xp.toString(16)}`);
    // Show 64 bytes before and 64 bytes after
    console.log('\n  Context (-64 to +64):');
    console.log(hexDump(ps, xp - 64, 160));
    
    // Read float64 BE at every byte offset in the area
    console.log('\n  All float64 BE values from -32 to +48:');
    for (let off = xp - 32; off < xp + 48 && off + 8 <= ps.length; off += 8) {
        const v = ps.readDoubleBE(off);
        if (isFinite(v) && Math.abs(v) < 1e6) {
            const inVal = v / 0.0254;
            console.log(`    @0x${off.toString(16)}: ${v.toFixed(8)} (${inVal.toFixed(4)} inches)`);
        } else {
            console.log(`    @0x${off.toString(16)}: ${v} (NaN/Inf/huge)`);
        }
    }
}
