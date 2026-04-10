/**
 * investigate12.mjs — Find record delimiters in failing Parasolid files.
 * Check all 0x3d (=) + next byte patterns, and look for
 * any other repeating delimiters/markers.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
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
        const compressedSize = buf.readUInt32LE(idx + 14);
        const decompressedSize = buf.readUInt32LE(idx + 18);
        const nameLength = buf.readUInt32LE(idx + 22);
        if (nameLength > 0 && nameLength < 1024 && compressedSize > 4 &&
            compressedSize < buf.length && decompressedSize > 4 && decompressedSize < 50_000_000) {
            const payloadOffset = idx + 26 + nameLength;
            const payloadEnd = payloadOffset + compressedSize;
            if (payloadEnd <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(payloadOffset, payloadEnd),
                        { maxOutputLength: decompressedSize + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (isParasolid(nested) && (!best || nested.length > best.length))
                                best = nested;
                        } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length))
                        best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

// Analyze ONE failing file in detail
const failFile = 'nist_ctc_03_asme1_rc_sw1802.SLDPRT';
const passFile = 'nist_ctc_01_asme1_rd_sw1802.SLDPRT';

for (const f of [passFile, failFile]) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`FILE: ${f} (${f === passFile ? 'PASSING' : 'FAILING'})`);
    const ps = getLargestPS(join(dir, f));
    if (!ps) { console.log('No PS data'); continue; }
    console.log(`Buffer: ${ps.length} bytes\n`);
    
    // Count all 0x3d + XX patterns
    console.log('All 0x3d (=) pairs:');
    const eqPairs = new Map();
    for (let i = 0; i < ps.length - 1; i++) {
        if (ps[i] === 0x3d) {
            const next = ps[i + 1];
            const key = `0x${next.toString(16).padStart(2, '0')} (${'=' + String.fromCharCode(next)})`;
            eqPairs.set(key, (eqPairs.get(key) || 0) + 1);
        }
    }
    for (const [k, v] of [...eqPairs.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${v}`);
    }
    
    // Most common byte sequences (2-byte) in the data area
    // Schema typically ends around byte 0x600 for the passing file.
    // Find the end of the schema/class definition area
    const schEnd = ps.indexOf('Z', 0x60, 'ascii'); // First 'Z' after schema start
    const dataAreaStart = Math.min(1500, ps.length); // Approximate: class defs end ~1500 bytes in
    
    console.log(`\nByte histogram of first unique byte after position ${dataAreaStart} (entity data area):`);
    const byteHist = new Uint32Array(256);
    for (let i = dataAreaStart; i < ps.length; i++) byteHist[ps[i]]++;
    const sortedBytes = [...Array(256).keys()].sort((a, b) => byteHist[b] - byteHist[a]);
    console.log('  Top 15 bytes:', sortedBytes.slice(0, 15).map(b => 
        `0x${b.toString(16).padStart(2, '0')}(${String.fromCharCode(b >= 0x20 && b <= 0x7e ? b : 0x2e)}):${byteHist[b]}`).join(', '));
    
    // Search for potential record boundary patterns in the data area
    // Look for any repeated multi-byte sequence that could be a delimiter
    const twoByteSeq = new Map();
    for (let i = dataAreaStart; i < ps.length - 1; i++) {
        const key = (ps[i] << 8) | ps[i + 1];
        twoByteSeq.set(key, (twoByteSeq.get(key) || 0) + 1);
    }
    const topPairs = [...twoByteSeq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log('\nTop 20 two-byte sequences in data area:');
    for (const [key, count] of topPairs) {
        const b1 = (key >> 8) & 0xff, b2 = key & 0xff;
        const c1 = b1 >= 0x20 && b1 <= 0x7e ? String.fromCharCode(b1) : '.';
        const c2 = b2 >= 0x20 && b2 <= 0x7e ? String.fromCharCode(b2) : '.';
        console.log(`  0x${b1.toString(16).padStart(2, '0')} 0x${b2.toString(16).padStart(2, '0')} (${c1}${c2}): ${count}`);
    }
    
    // Dump bytes around position 1500-2500 (where entity data should begin)
    console.log(`\nHex dump @ ${dataAreaStart}-${dataAreaStart + 500}:`);
    for (let off = dataAreaStart; off < Math.min(dataAreaStart + 500, ps.length); off += 32) {
        const slice = ps.subarray(off, Math.min(off + 32, ps.length));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        console.log(`  ${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
    
    // Also try: find ALL float64 BE values in data area that look valid,
    // regardless of any marker
    let beFloatCount = 0;
    const coordCandidates = [];
    for (let i = dataAreaStart; i + 24 <= ps.length; i += 8) {
        const x = ps.readDoubleBE(i);
        const y = ps.readDoubleBE(i + 8);
        const z = ps.readDoubleBE(i + 16);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) continue;
        if (x === 0 && y === 0 && z === 0) continue;
        if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-15) continue;
        beFloatCount++;
        if (coordCandidates.length < 30)
            coordCandidates.push({ x, y, z, offset: i });
    }
    console.log(`\nBE float64 triplets (8-aligned, no marker needed): ${beFloatCount}`);
    if (coordCandidates.length > 0) {
        console.log('First 20:', coordCandidates.slice(0, 20).map(p => 
            `(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) @0x${p.offset.toString(16)}`));
    }
}
