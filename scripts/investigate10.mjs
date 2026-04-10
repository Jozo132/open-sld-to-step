/**
 * investigate10.mjs — Check ALL failing NIST files to understand why
 * some still return 0 vertices after the BE + largest-section fix.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function isParasolid(buf) {
    if (buf.length < 20) return false;
    if (buf[0] === 0x50 && buf[1] === 0x53) {
        const idx = buf.indexOf('TRANSMIT', 0, 'ascii');
        if (idx >= 0 && idx < 32) return true;
    }
    const head = buf.subarray(0, 4).toString('ascii');
    return head === 'P_S_' || head === 'PARA' || head === 'PS-P' || head === 'PS-A' || head === 'PS-S';
}

function analyzeFile(filePath) {
    const buf = readFileSync(filePath);
    const psSections = [];
    let idx = 0;
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
                    let nested = null;
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try { nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 }); } catch {}
                    }
                    if (isParasolid(dec)) {
                        psSections.push({ offset: idx, size: dec.length, source: 'direct', data: dec });
                    }
                    if (nested && isParasolid(nested)) {
                        psSections.push({ offset: idx, size: nested.length, source: 'nested', data: nested });
                    }
                } catch {}
            }
        }
        idx++;
    }
    return psSections;
}

function countMarkers(buf) {
    let p = 0, q = 0;
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x3d) {
            if (buf[i+1] === 0x70) p++;
            else if (buf[i+1] === 0x71) q++;
        }
    }
    return { p, q };
}

function extractBEtriplets(buf) {
    const markers = [];
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x3d && (buf[i+1] === 0x70 || buf[i+1] === 0x71))
            markers.push(i);
    }
    const pts = new Set();
    for (let mi = 0; mi < markers.length; mi++) {
        const mOff = markers[mi];
        const isP = buf[mOff+1] === 0x70;
        const recordEnd = mi+1 < markers.length ? markers[mi+1] : Math.min(mOff + 20000, buf.length);
        const dataStart = mOff + (isP ? 5 : 2);
        for (let j = dataStart; j + 24 <= recordEnd; j++) {
            const x = buf.readDoubleBE(j);
            const y = buf.readDoubleBE(j+8);
            const z = buf.readDoubleBE(j+16);
            if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
            if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) continue;
            if (x === 0 && y === 0 && z === 0) continue;
            if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-15) continue;
            pts.add(`${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`);
            if (pts.size >= 200) break;
        }
        if (pts.size >= 200) break;
    }
    return pts.size;
}

const failing = ['nist_ctc_03', 'nist_ctc_05', 'nist_ftc_06', 'nist_ftc_07', 'nist_ftc_08', 'nist_ftc_09', 'nist_ftc_11'];
const passing = ['nist_ctc_01', 'nist_ctc_02', 'nist_ctc_04', 'nist_ftc_10'];

console.log('=== ALL FILES ===\n');
for (const f of files) {
    const prefix = f.replace(/_asme.*/, '');
    const status = failing.some(fp => f.startsWith(fp)) ? 'FAIL' : 'PASS';
    const sects = analyzeFile(join(dir, f));
    
    const info = sects.map(s => {
        const m = countMarkers(s.data);
        const triplets = extractBEtriplets(s.data);
        return `${s.source}:${s.size}b =p:${m.p} =q:${m.q} triplets:${triplets}`;
    });
    
    console.log(`[${status}] ${f}`);
    console.log(`  PS sections: ${sects.length}`);
    for (const i of info) console.log(`    ${i}`);
    if (sects.length > 0) {
        const largest = sects.reduce((a, b) => a.size > b.size ? a : b);
        console.log(`  → Will pick: ${largest.source}:${largest.size}b`);
    }
    console.log('');
}
