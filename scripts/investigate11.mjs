/**
 * investigate11.mjs — Examine the Parasolid data from failing files
 * that have 0 =p/=q markers. These may be text-format Parasolid.
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function isParasolid(buf) {
    if (buf.length < 20) return false;
    if (buf[0] === 0x50 && buf[1] === 0x53) {
        const idx = buf.indexOf('TRANSMIT', 0, 'ascii');
        if (idx >= 0 && idx < 32) return true;
    }
    return false;
}

function getLargestPS(filePath) {
    const buf = readFileSync(filePath);
    let best = null;
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
                    // Try nested decompression
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

// Focus on failing files
const failing = [
    'nist_ctc_03_asme1_rc_sw1802.SLDPRT',
    'nist_ftc_08_asme1_rc_sw1802.SLDPRT',
    'nist_ftc_11_asme1_rb_sw1802.SLDPRT',
];

for (const f of failing) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`FILE: ${f}`);
    const ps = getLargestPS(join(dir, f));
    if (!ps) { console.log('  No PS data!'); continue; }
    
    console.log(`  Size: ${ps.length} bytes`);
    
    // Check text ratio
    let printable = 0;
    for (let i = 0; i < Math.min(ps.length, 10000); i++) {
        if (ps[i] >= 0x20 && ps[i] <= 0x7e || ps[i] === 0x0a || ps[i] === 0x0d || ps[i] === 0x09)
            printable++;
    }
    const textRatio = printable / Math.min(ps.length, 10000);
    console.log(`  Text ratio (first 10KB): ${(textRatio * 100).toFixed(1)}%`);
    
    // Show first 2000 bytes as text (replacing non-printable with dots)
    console.log('\n  --- First 2000 bytes as text ---');
    const text = ps.subarray(0, 2000).toString('latin1').replace(/[\x00-\x08\x0b\x0e-\x1f\x80-\xff]/g, '.');
    console.log(text);
    
    // Check if it contains newlines (text format)
    const newlines = ps.subarray(0, 10000);
    let nlCount = 0;
    for (let i = 0; i < newlines.length; i++) if (newlines[i] === 0x0a) nlCount++;
    console.log(`\n  Newlines in first 10KB: ${nlCount}`);
    
    // Look for text-format coordinate patterns  
    const textContent = ps.toString('latin1');
    
    // Text Parasolid has lines like "3 0.05 -0.7071 0.0" for coordinates
    const floatPattern = /-?\d+\.\d+/g;
    let floats = [];
    let m;
    while ((m = floatPattern.exec(textContent)) !== null && floats.length < 50) {
        floats.push({ value: parseFloat(m[0]), offset: m.index });
    }
    console.log(`\n  Float-like strings found: ${floats.length}`);
    if (floats.length > 0) {
        console.log('  First 20:', floats.slice(0, 20).map(f => `${f.value} @${f.offset}`).join(', '));
    }
    
    // Look for typical text Parasolid entity markers
    const textMarkers = ['BODY ', 'SHELL ', 'FACE ', 'LOOP ', 'EDGE ', 'VERTEX ', 'POINT ',
                         'SURFACE ', 'CURVE ', 'PLANE ', 'CYLINDER ', 'CONE ', 'SPHERE '];
    console.log('\n  Text entity markers:');
    for (const tm of textMarkers) {
        let count = 0, pos = 0;
        while ((pos = textContent.indexOf(tm, pos)) >= 0) { count++; pos++; }
        if (count > 0) console.log(`    ${tm.trim()}: ${count}`);
    }
    
    // Hex dump of first 200 bytes
    console.log('\n  --- First 200 bytes hex ---');
    for (let off = 0; off < Math.min(200, ps.length); off += 32) {
        const slice = ps.subarray(off, Math.min(off + 32, ps.length));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        console.log(`  ${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
}
