/**
 * investigate9.mjs — Confirm Big Endian float64 in Parasolid records 
 * and test coordinate extraction with correct endianness.
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function extractLargestParasolid(filePath) {
    const buf = readFileSync(filePath);
    let idx = 0, best = null;
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
                            const inner = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (inner.length >= 20 && inner[0] === 0x50 && inner[1] === 0x53 &&
                                inner.indexOf('TRANSMIT', 0, 'ascii') >= 0) {
                                if (!best || inner.length > best.length) best = inner;
                            }
                        } catch {}
                    }
                    if (dec.length >= 20 && dec[0] === 0x50 && dec[1] === 0x53 &&
                        dec.indexOf('TRANSMIT', 0, 'ascii') >= 0) {
                        if (!best || dec.length > best.length) best = dec;
                    }
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

const ps = extractLargestParasolid(join(dir, files[0]));
console.log(`Parasolid buffer: ${ps.length} bytes from ${files[0]}\n`);

// Find all =p/=q markers
const markers = [];
for (let i = 0; i < ps.length - 1; i++) {
    if (ps[i] === 0x3d && (ps[i+1] === 0x70 || ps[i+1] === 0x71))
        markers.push({ offset: i, type: ps[i+1] === 0x70 ? 'p' : 'q' });
}

// Try extracting coordinate triplets with BE vs LE
function extractFloats(buf, useBE, markers) {
    const points = [];
    const seen = new Set();
    
    for (const m of markers) {
        const nextM = markers.find(mm => mm.offset > m.offset);
        const recordEnd = nextM ? nextM.offset : Math.min(m.offset + 20000, buf.length);
        const recordStart = m.offset + 2;
        
        for (let j = recordStart; j + 24 <= recordEnd; j++) {
            const x = useBE ? buf.readDoubleBE(j) : buf.readDoubleLE(j);
            const y = useBE ? buf.readDoubleBE(j + 8) : buf.readDoubleLE(j + 8);
            const z = useBE ? buf.readDoubleBE(j + 16) : buf.readDoubleLE(j + 16);
            
            if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
            if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(z) > 1e6) continue;
            if (x === 0 && y === 0 && z === 0) continue;
            const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
            if (mag < 1e-15) continue;
            
            const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push({ x, y, z, offset: j, markerType: m.type, markerOff: m.offset });
        }
    }
    return points;
}

const ptsLE = extractFloats(ps, false, markers);
const ptsBE = extractFloats(ps, true, markers);

console.log(`=== Little Endian: ${ptsLE.length} unique triplets ===`);
if (ptsLE.length > 0) {
    console.log('  First 10:', ptsLE.slice(0, 10).map(p =>
        `(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) @+${p.offset - p.markerOff}`));
}

console.log(`\n=== Big Endian: ${ptsBE.length} unique triplets ===`);
if (ptsBE.length > 0) {
    console.log('  First 20:', ptsBE.slice(0, 20).map(p =>
        `(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) @0x${p.markerOff.toString(16)}+${p.offset - p.markerOff} [=${p.markerType}]`));
}

// Check for common geometric values in BE results
const specialValues = ptsBE.filter(p => {
    const vals = [p.x, p.y, p.z];
    return vals.some(v => {
        const av = Math.abs(v);
        return Math.abs(av - 0.7071067811865) < 0.001 || // sqrt(2)/2
               Math.abs(av - 1.0) < 0.0001 ||
               Math.abs(av - 0.5) < 0.0001 ||
               Math.abs(av - Math.PI) < 0.01;
    });
});
console.log(`\nBE triplets with special geometric values (sqrt2/2, 1.0, 0.5, pi): ${specialValues.length}`);
if (specialValues.length > 0) {
    console.log('  ', specialValues.slice(0, 10).map(p =>
        `(${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)})`));
}

// Also: try 8-byte aligned positions only (after the 5-byte record header)
function extractAligned(buf, markers) {
    const points = [];
    const seen = new Set();
    
    for (const m of markers) {
        const nextM = markers.find(mm => mm.offset > m.offset);
        const recordEnd = nextM ? nextM.offset : Math.min(m.offset + 20000, buf.length);
        // Skip 2 bytes marker + 3 bytes tag = 5 bytes header, then try 8-byte aligned
        const recordStart = m.offset + 5;
        
        for (let j = recordStart; j + 24 <= recordEnd; j += 8) {
            const x = buf.readDoubleBE(j);
            const y = buf.readDoubleBE(j + 8);
            const z = buf.readDoubleBE(j + 16);
            
            if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
            if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(z) > 1e6) continue;
            if (x === 0 && y === 0 && z === 0) continue;
            const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
            if (mag < 1e-15) continue;
            
            const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push({ x, y, z, offset: j, markerOff: m.offset });
        }
    }
    return points;
}

const ptsAligned = extractAligned(ps, markers);
console.log(`\n=== BE 8-byte aligned (after 5-byte header): ${ptsAligned.length} triplets ===`);
if (ptsAligned.length > 0) {
    console.log('  First 20:', ptsAligned.slice(0, 20).map(p =>
        `(${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)}) @0x${p.markerOff.toString(16)}+${p.offset - p.markerOff}`));
}

// Summary stats for BE results
if (ptsBE.length > 0) {
    const allVals = ptsBE.flatMap(p => [p.x, p.y, p.z]);
    console.log(`\nBE coordinate ranges:`);
    console.log(`  X: [${Math.min(...ptsBE.map(p=>p.x)).toFixed(6)}, ${Math.max(...ptsBE.map(p=>p.x)).toFixed(6)}]`);
    console.log(`  Y: [${Math.min(...ptsBE.map(p=>p.y)).toFixed(6)}, ${Math.max(...ptsBE.map(p=>p.y)).toFixed(6)}]`);
    console.log(`  Z: [${Math.min(...ptsBE.map(p=>p.z)).toFixed(6)}, ${Math.max(...ptsBE.map(p=>p.z)).toFixed(6)}]`);
}
