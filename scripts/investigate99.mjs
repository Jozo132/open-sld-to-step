/**
 * investigate99.mjs — FTC_11 full buffer geometry scan
 *
 * FTC_11 has only 6 sentinel-based entities (3 SHELL + 3 BSPLINE),
 * but the reference needs 2 planes, 2 cylinders, 2 tori, 6 faces,
 * and ~49 vertices. Most geometry must be encoded outside sentinel
 * blocks or in a different format.
 *
 * Strategy:
 * 1. Dump sentinel positions to see buffer layout
 * 2. Check for =p/=q markers
 * 3. Scan full buffer for float64 BE triplets in engineering range
 * 4. Look at bytes around known-good positions (r=31.5, vertices)
 * 5. Find ALL 11-float sequences (potential cylinders/cones)
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENT = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const MM = 1000;

function isPS(b) { return b.length > 20 && b[0] === 0x50 && b[1] === 0x53 && b.indexOf('TRANSMIT', 0, 'ascii') >= 0 && b.indexOf('TRANSMIT', 0, 'ascii') < 32; }

function getPS(fp) {
    const buf = readFileSync(fp);
    let best = null, i = 0;
    while ((i = buf.indexOf(SW3D, i)) >= 0) {
        if (i + 26 > buf.length) break;
        const cs = buf.readUInt32LE(i + 14), ds = buf.readUInt32LE(i + 18), nl = buf.readUInt32LE(i + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50e6) {
            const po = i + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const d = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (d.length > 28 && d[28] === 0x78) {
                        try { const n = inflateSync(d.subarray(28), { maxOutputLength: 50e6 }); if (isPS(n) && (!best || n.length > best.length)) best = n; } catch { }
                    }
                    if (isPS(d) && (!best || d.length > best.length)) best = d;
                } catch { }
            }
        }
        i++;
    }
    return best;
}

const ps = getPS(join(dir, 'nist_ftc_11_asme1_rb_sw1802.SLDPRT'));
console.log('PS buffer length:', ps.length);

// 1. Sentinel positions
const sents = [];
let idx = 0;
while ((idx = ps.indexOf(SENT, idx)) >= 0) { sents.push(idx); idx += SENT.length; }
console.log('\nSentinel positions:', sents.length, '→', sents.join(', '));
console.log('Pre-sentinel region: 0 to', sents[0] || 'none');
for (let i = 0; i < sents.length; i++) {
    const end = (i + 1 < sents.length) ? sents[i + 1] : ps.length;
    console.log(`  Block ${i}: ${sents[i]}..${end} (${end - sents[i]} bytes)`);
}

// 2. =p/=q markers
let pCount = 0, qCount = 0;
for (let off = 0; off < ps.length - 1; off++) {
    if (ps[off] === 0x3d) {
        if (ps[off + 1] === 0x70) pCount++;
        else if (ps[off + 1] === 0x71) qCount++;
    }
}
console.log(`\n=p markers: ${pCount}, =q markers: ${qCount}`);

// 3. Find the PS header/schema end
const headerEnd = ps.indexOf('SCH_', 0, 'ascii');
console.log('SCH_ at offset:', headerEnd);
// Find last 'Z' in first 2000 bytes
let lastZ = -1;
for (let i = Math.min(2000, ps.length) - 1; i >= 0; i--) {
    if (ps[i] === 0x5a) { lastZ = i; break; }
}
console.log('Last Z (schema end) at:', lastZ);

// 4. Dump pre-sentinel area structure (between schema end and first sentinel)
const preStart = lastZ + 1;
const preEnd = sents[0] || ps.length;
console.log(`\nPre-sentinel data region: ${preStart}..${preEnd} (${preEnd - preStart} bytes)`);

// 5. Scan for ALL float64 BE triplets that look like coordinates
console.log('\n=== COORDINATE TRIPLETS (engineering range) ===');
const coordResults = [];
for (let off = preStart; off + 24 <= ps.length; off++) {
    const x = ps.readDoubleBE(off);
    const y = ps.readDoubleBE(off + 8);
    const z = ps.readDoubleBE(off + 16);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (Math.abs(x) > 0.1 || Math.abs(y) > 0.1 || Math.abs(z) > 0.1) continue; // meters range
    if (x === 0 && y === 0 && z === 0) continue;
    // At least one component > 0.001 (1mm)
    if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) < 0.001) continue;
    
    const xmm = x * MM, ymm = y * MM, zmm = z * MM;
    // Check which sentinel block this falls in
    let block = 'pre-sentinel';
    for (let s = 0; s < sents.length; s++) {
        if (off >= sents[s]) block = `block${s}`;
    }
    coordResults.push({ off, xmm, ymm, zmm, block });
}
console.log(`Found ${coordResults.length} candidate triplets`);
for (const cr of coordResults.slice(0, 60)) {
    console.log(`  off=${cr.off} ${cr.block}: (${cr.xmm.toFixed(4)}, ${cr.ymm.toFixed(4)}, ${cr.zmm.toFixed(4)}) mm`);
}

// 6. Look at bytes around r=31.5mm occurrences
console.log('\n=== CONTEXT AROUND r=31.5mm OCCURRENCES ===');
const r315positions = [];
for (let off = 0; off + 8 <= ps.length; off++) {
    const v = ps.readDoubleBE(off);
    if (Math.abs(v - 0.0315) < 1e-10) r315positions.push(off);
}
for (const pos of r315positions.slice(0, 5)) {
    console.log(`\nOffset ${pos}:`);
    const start = Math.max(0, pos - 16);
    const end = Math.min(ps.length, pos + 96);
    const chunk = ps.subarray(start, end);
    for (let row = 0; row < chunk.length; row += 32) {
        const slice = chunk.subarray(row, Math.min(row + 32, chunk.length));
        const hexStr = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`  ${(start + row).toString().padStart(5)}: ${hexStr}`);
    }
    // Read surrounding floats
    const fStart = Math.max(0, pos - 80);
    const floats = [];
    for (let fo = pos - 80; fo <= pos + 80; fo += 8) {
        if (fo < 0 || fo + 8 > ps.length) continue;
        const v = ps.readDoubleBE(fo);
        if (isFinite(v) && Math.abs(v) < 1e6) {
            floats.push({ off: fo, val: v, mm: v * MM });
        }
    }
    console.log('  Nearby floats:');
    for (const f of floats) {
        const marker = f.off === pos ? ' <<<< r=31.5' : '';
        console.log(`    off=${f.off}: ${f.val.toFixed(10)} (${f.mm.toFixed(4)} mm)${marker}`);
    }
}

// 7. Look for 0x2B markers in pre-sentinel region
console.log('\n=== 0x2B MARKERS IN PRE-SENTINEL REGION ===');
for (let off = preStart; off < preEnd; off++) {
    if (ps[off] !== 0x2b) continue;
    // Read floats after marker
    const floats = [];
    for (let fo = off + 1; fo + 8 <= ps.length; fo += 8) {
        const v = ps.readDoubleBE(fo);
        if (!isFinite(v) || Math.abs(v) > 1e6) break;
        floats.push(v);
    }
    if (floats.length >= 3) {
        const tag = floats.length === 7 ? 'PLANE?' :
            floats.length === 11 ? 'CYL?' :
                floats.length >= 13 ? 'TORUS?' : `${floats.length}f`;
        console.log(`  off=${off}: ${floats.length} floats [${tag}]`);
        for (let fi = 0; fi < Math.min(floats.length, 15); fi++) {
            console.log(`    [${fi}] = ${floats[fi].toFixed(10)} (${(floats[fi] * MM).toFixed(4)} mm)`);
        }
    }
}
