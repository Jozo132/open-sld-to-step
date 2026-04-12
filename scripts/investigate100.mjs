/**
 * investigate100.mjs — FTC_11 entity id=46 detailed float dump
 *
 * Dump the exact float contents of all type-0x1F entities in FTC_11 to understand
 * why the r=31.5mm outer cylinder is not being extracted. The hypothesis is that
 * entity id=46 contains TWO cylinders (r=16mm and r=31.5mm) back-to-back in its
 * 23-float payload, and only the first 11 are being read.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

// ── Helpers ─────────────────────────────────────────────────────────────────
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP  = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const SW3D     = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function findAll(buf, needle) {
    const positions = [];
    let idx = 0;
    while ((idx = buf.indexOf(needle, idx)) >= 0) {
        positions.push(idx);
        idx += needle.length;
    }
    return positions;
}

function isPS(b) {
    return b.length > 20 && b[0] === 0x50 && b[1] === 0x53 &&
           b.indexOf('TRANSMIT', 0, 'ascii') >= 0 && b.indexOf('TRANSMIT', 0, 'ascii') < 32;
}

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

// ── Load FTC_11 ─────────────────────────────────────────────────────────────
const sldPath = join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018', 'nist_ftc_11_asme1_rb_sw1802.SLDPRT');
const psBuf = getPS(sldPath);
if (!psBuf) { console.log('FAIL: no PS buffer'); process.exit(1); }
console.log(`PS buffer: ${psBuf.length} bytes`);

// ── Find sentinels ──────────────────────────────────────────────────────────
const sents = findAll(psBuf, SENTINEL);
console.log(`\nSentinels: ${sents.length} at positions [${sents.join(', ')}]`);

// ── Extract entities from sentinel blocks ───────────────────────────────────
console.log('\n=== ALL ENTITIES ===');

for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + SENTINEL.length;
    const blockEnd = (i + 1 < sents.length) ? sents[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    if (block.length < 8) continue;

    // Split by sub-record separator
    const subs = [];
    let search = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, search);
        if (sepIdx < 0) {
            subs.push({ data: block.subarray(search), off: blockStart + search });
            break;
        }
        subs.push({ data: block.subarray(search, sepIdx), off: blockStart + search });
        search = sepIdx + SUB_SEP.length;
    }

    for (let si = 0; si < subs.length; si++) {
        const rec = subs[si].data;
        const absOff = subs[si].off;
        let type, id, data;
        
        if (si === 0) {
            if (rec.length < 8) continue;
            if (rec.readUInt32BE(0) !== 3) continue;
            type = rec[5];
            id = rec.readUInt16BE(6);
            data = rec.subarray(8);
        } else {
            if (rec.length < 4) continue;
            if (rec[0] !== 0x00) continue;
            type = rec[1];
            id = rec.readUInt16BE(2);
            data = rec.subarray(4);
        }

        const typeName = {
            0x0f: 'FACE', 0x10: 'EDGE', 0x11: 'SHELL/BODY', 0x12: 'COEDGE',
            0x13: 'LOOP', 0x1d: 'POINT', 0x1e: 'SURFACE', 0x1f: 'BSPLINE',
            0x20: 'ATTRIB'
        }[type] || `UNKNOWN(0x${type.toString(16)})`;

        console.log(`\nBlock ${i}, sub ${si}: type=0x${type.toString(16)} (${typeName}) id=${id} dataLen=${data.length} absOff=${absOff}`);

        // For type 0x1F, dump ALL 0x2B markers and ALL floats after each
        if (type === 0x1f) {
            console.log(`  Raw hex (first 120 bytes): ${data.subarray(0, 120).toString('hex').match(/../g).join(' ')}`);
            
            // Find ALL 0x2B markers in data
            for (let m = 0; m < data.length; m++) {
                if (data[m] !== 0x2b) continue;
                const floats = [];
                for (let fo = m + 1; fo + 8 <= data.length; fo += 8) {
                    const v = data.readDoubleBE(fo);
                    if (!isFinite(v) || Math.abs(v) > 1e6) break;
                    floats.push(v);
                }
                if (floats.length >= 3) {
                    console.log(`  0x2B at data[${m}] (abs ${absOff + (si === 0 ? 8 : 4) + m}): ${floats.length} floats`);
                    for (let fi = 0; fi < floats.length; fi++) {
                        const mm = floats[fi] * 1000;
                        console.log(`    [${fi}] ${floats[fi].toFixed(10)} = ${mm.toFixed(4)} mm`);
                    }
                    // Try to interpret as cylinders
                    for (let start = 0; start + 11 <= floats.length; start += 11) {
                        const o = floats.slice(start, start + 3);
                        const a = floats.slice(start + 3, start + 6);
                        const rd = floats.slice(start + 6, start + 9);
                        const r = floats[start + 9];
                        const sa = floats[start + 10];
                        const aMag = Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]);
                        console.log(`    --- 11-float chunk at [${start}]: origin(${o.map(v=>(v*1000).toFixed(2)).join(',')}mm) axis(${a.map(v=>v.toFixed(4)).join(',')}) r=${(r*1000).toFixed(2)}mm semiAngle=${sa.toFixed(6)} axisMag=${aMag.toFixed(6)}`);
                    }
                }
            }
            
            // Also try 0x2D markers
            for (let m = 0; m < data.length; m++) {
                if (data[m] !== 0x2d) continue;
                const floats = [];
                for (let fo = m + 1; fo + 8 <= data.length; fo += 8) {
                    const v = data.readDoubleBE(fo);
                    if (!isFinite(v) || Math.abs(v) > 1e6) break;
                    floats.push(v);
                }
                if (floats.length >= 3) {
                    console.log(`  0x2D at data[${m}] (abs ${absOff + (si === 0 ? 8 : 4) + m}): ${floats.length} floats`);
                    for (let fi = 0; fi < floats.length; fi++) {
                        const mm = floats[fi] * 1000;
                        console.log(`    [${fi}] ${floats[fi].toFixed(10)} = ${mm.toFixed(4)} mm`);
                    }
                }
            }
        }

        // For type 0x1E, same treatment
        if (type === 0x1e) {
            console.log(`  Raw hex (first 80 bytes): ${data.subarray(0, 80).toString('hex').match(/../g).join(' ')}`);
            for (let m = 0; m < data.length; m++) {
                if (data[m] !== 0x2b && data[m] !== 0x2d) continue;
                const floats = [];
                for (let fo = m + 1; fo + 8 <= data.length; fo += 8) {
                    const v = data.readDoubleBE(fo);
                    if (!isFinite(v) || Math.abs(v) > 1e6) break;
                    floats.push(v);
                }
                if (floats.length >= 3) {
                    const marker = data[m] === 0x2b ? '0x2B' : '0x2D';
                    console.log(`  ${marker} at data[${m}]: ${floats.length} floats`);
                    for (let fi = 0; fi < floats.length; fi++) {
                        console.log(`    [${fi}] ${floats[fi].toFixed(10)} = ${(floats[fi]*1000).toFixed(4)} mm`);
                    }
                }
            }
        }
    }
}

// ── Also look for geometry in the LARGE block (block 11) ────────────────────
console.log('\n\n=== BLOCK 11 DETAILED ANALYSIS ===');
if (sents.length >= 12) {
    const blockStart = sents[11] + SENTINEL.length;
    const blockEnd = psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    console.log(`Block 11: ${blockStart}..${blockEnd} (${block.length} bytes)`);

    // Split by sub-record separator
    const subs = [];
    let search = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, search);
        if (sepIdx < 0) {
            subs.push({ data: block.subarray(search), off: blockStart + search });
            break;
        }
        subs.push({ data: block.subarray(search, sepIdx), off: blockStart + search });
        search = sepIdx + SUB_SEP.length;
    }
    
    console.log(`Block 11 has ${subs.length} sub-records`);

    for (let si = 0; si < subs.length; si++) {
        const rec = subs[si].data;
        if (rec.length < 4) continue;
        
        let type, id;
        if (si === 0) {
            if (rec.length < 8 || rec.readUInt32BE(0) !== 3) { console.log(`Sub 0: not primary entity`); continue; }
            type = rec[5];
            id = rec.readUInt16BE(6);
        } else {
            if (rec[0] !== 0x00) { console.log(`Sub ${si}: first byte not 0x00 (is 0x${rec[0].toString(16)})`); continue; }
            type = rec[1];
            id = rec.readUInt16BE(2);
        }

        const typeName = { 0x0f: 'FACE', 0x10: 'EDGE', 0x11: 'SHELL/BODY', 0x12: 'COEDGE', 0x13: 'LOOP', 0x1d: 'POINT', 0x1e: 'SURFACE', 0x1f: 'BSPLINE' }[type] || `0x${type.toString(16)}`;
        console.log(`  Sub ${si}: type=${typeName} id=${id} len=${rec.length}`);
        
        // For geometry types, dump floats
        if (type === 0x1e || type === 0x1f || type === 0x1d) {
            const data = si === 0 ? rec.subarray(8) : rec.subarray(4);
            // Find 0x2B/0x2D markers
            for (let m = 0; m < data.length; m++) {
                if (data[m] !== 0x2b && data[m] !== 0x2d) continue;
                const floats = [];
                for (let fo = m + 1; fo + 8 <= data.length; fo += 8) {
                    const v = data.readDoubleBE(fo);
                    if (!isFinite(v) || Math.abs(v) > 1e6) break;
                    floats.push(v);
                }
                if (floats.length >= 3) {
                    const marker = data[m] === 0x2b ? '0x2B' : '0x2D';
                    console.log(`    ${marker} at data[${m}]: ${floats.length} floats`);
                    for (let fi = 0; fi < Math.min(floats.length, 30); fi++) {
                        console.log(`      [${fi}] ${floats[fi].toFixed(10)} = ${(floats[fi]*1000).toFixed(4)} mm`);
                    }
                }
            }
            
            // For POINT entities, scan for float64 triplets
            if (type === 0x1d) {
                for (let off2 = 0; off2 + 24 <= data.length; off2++) {
                    const x = data.readDoubleBE(off2);
                    const y = data.readDoubleBE(off2 + 8);
                    const z = data.readDoubleBE(off2 + 16);
                    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
                    if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) continue;
                    const xmm = x*1000, ymm = y*1000, zmm = z*1000;
                    if (Math.abs(xmm) < 0.001 && Math.abs(ymm) < 0.001 && Math.abs(zmm) < 0.001) continue;
                    console.log(`    Candidate point at data[${off2}]: (${xmm.toFixed(2)}, ${ymm.toFixed(2)}, ${zmm.toFixed(2)}) mm`);
                }
            }
        }
    }
}

// ── Scan entire buffer for float64 triplets that look like FTC_11 reference data ──
console.log('\n\n=== TARGETED FLOAT SCAN (reference geometry) ===');
// Reference: planes at z=-1.5mm and z=0.425mm
// Reference: cylinders r=16mm and r=31.5mm
// Reference: tori R=30,r=1.5 and R=17.5,r=1.5
// Reference: vertices include (0,-31.5,-1.5), (0,-16,-1.5), (0,-31.5,0.425), etc.

const targets = [
    { name: 'z=-1.5mm (plane origin z)', val: -0.0015, tol: 0.00001 },
    { name: 'z=0.425mm (plane origin z)', val: 0.000425, tol: 0.00001 },
    { name: 'r=31.5mm', val: 0.0315, tol: 0.00005 },
    { name: 'r=16mm', val: 0.016, tol: 0.00005 },
    { name: 'R=30mm (torus major)', val: 0.030, tol: 0.00005 },
    { name: 'R=17.5mm (torus major)', val: 0.0175, tol: 0.00005 },
    { name: 'r=1.5mm (torus minor)', val: 0.0015, tol: 0.00005 },
];

for (const t of targets) {
    console.log(`\nSearching for ${t.name} (${t.val}):`);
    let found = 0;
    for (let off2 = 0; off2 + 8 <= psBuf.length; off2++) {
        const v = psBuf.readDoubleBE(off2);
        if (Math.abs(v - t.val) < t.tol) {
            // Show context: bytes before for header detection
            const ctxStart = Math.max(0, off2 - 16);
            const ctxEnd = Math.min(psBuf.length, off2 + 24);
            const hex = psBuf.subarray(ctxStart, ctxEnd).toString('hex').match(/../g).join(' ');
            // Which sentinel block?
            let blockIdx = -1;
            for (let si = sents.length - 1; si >= 0; si--) {
                if (sents[si] <= off2) { blockIdx = si; break; }
            }
            console.log(`  offset ${off2} (block ${blockIdx}): hex=${hex}`);
            found++;
            if (found >= 5) { console.log('  ... (more)'); break; }
        }
    }
    if (found === 0) console.log('  NOT FOUND');
}
