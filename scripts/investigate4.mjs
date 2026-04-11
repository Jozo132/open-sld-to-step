/**
 * investigate4.mjs
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function extractLargestParasolid(filePath) {
    const buf = readFileSync(filePath);
    let fidx = 0;
    let best = null;
    while ((fidx = buf.indexOf(SW3D_MARKER, fidx)) >= 0) {
        if (fidx + 26 > buf.length) break;
        const fcs = buf.readUInt32LE(fidx + 14);
        const fds = buf.readUInt32LE(fidx + 18);
        const fnl = buf.readUInt32LE(fidx + 22);
        if (fnl > 0 && fnl < 1024 && fcs > 4 && fcs < buf.length && fds > 4 && fds < 500000000) {
            const fpo = fidx + 26 + fnl;
            const fpe = fpo + fcs;
            if (fpe <= buf.length) {
                try {
                    const fdec = inflateRawSync(buf.subarray(fpo, fpe), {maxOutputLength: fds + 1024});
                    if (fdec.length > 28 && fdec[28] === 0x78) {
                        try {
                            const inner = inflateSync(fdec.subarray(28));
                            if (inner.length > (best ? best.length : 0)) best = inner;
                        } catch {}
                    }
                } catch {}
            }
        }
        fidx++;
    }
    return best;
}

// Analyze file 0 (largest Parasolid section - 129KB)
const ps = extractLargestParasolid(join(dir, files[0]));
if (!ps) { console.log('No data'); process.exit(1); }

// The Parasolid binary transmit format has:
// 1. Header: PS\x00\x00\x00?: TRANSMIT FILE (partition) created by modeller version NNNNNNN\n
// 2. Schema line: SCH_NNNNNNN_NNNNN_NNNNN\n
// 3. Schema definition (field names and types)
// 4. Entity data records
//
// Let's trace through the binary structure byte by byte

// Find end of header line (first newline)
let pos = 0;
const headerEnd = ps.indexOf(0x0A, pos);  // newline
console.log('Header line:', ps.subarray(0, headerEnd).toString('ascii').replace(/[^\x20-\x7e]/g, '.'));
pos = headerEnd + 1;

// Find schema line
const schemaEnd = ps.indexOf(0x0A, pos);
console.log('Schema line:', ps.subarray(pos, schemaEnd).toString('ascii').replace(/[^\x20-\x7e]/g, '.'));
pos = schemaEnd + 1;

// Now examine the binary structure after the schema line
// Show next 500 bytes in detail
console.log('\n=== Post-schema data (hex + ascii) ===');
for (let i = 0; i < 20; i++) {
    const lineStart = pos + i * 32;
    if (lineStart >= ps.length) break;
    const lineEnd = Math.min(lineStart + 32, ps.length);
    const hex = ps.subarray(lineStart, lineEnd).toString('hex').replace(/(.{2})/g, '$1 ').trim();
    const ascii = ps.subarray(lineStart, lineEnd).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
    console.log(`  ${String(lineStart).padStart(6, '0')}: ${hex.padEnd(96, ' ')} ${ascii}`);
}

// Look for the entity record structure
// Parasolid binary uses a tag-based record format where each entity class
// has a numeric ID and fields are serialized as typed values
// Let's find all occurrences of known entity class names
const classNames = ['BODY', 'SHELL', 'FACE', 'LOOP', 'FIN', 'EDGE', 'VERTEX', 'POINT', 'SURFACE', 'CURVE', 'PLANE', 'CYLINDER', 'LINE', 'CIRCLE', 'REGION', 'LUMP', 'ATTRIB', 'CONE', 'SPHERE', 'TORUS'];
console.log('\n=== Entity class name occurrences ===');
for (const name of classNames) {
    let count = 0;
    let p = 0;
    while ((p = ps.indexOf(name, p, 'ascii')) >= 0) { count++; p++; }
    if (count > 0) console.log(`  ${name}: ${count}`);
}

// Let's look at the "=p" and "=q" patterns which seem to be record markers
let eqCount = 0;
const recordStarts = [];
for (let i = 0; i < ps.length - 1; i++) {
    if (ps[i] === 0x3d && (ps[i+1] === 0x70 || ps[i+1] === 0x71)) { // '=p' or '=q'
        eqCount++;
        if (recordStarts.length < 5) recordStarts.push(i);
    }
}
console.log(`\n=== Record markers (=p/=q): ${eqCount} ===`);
for (const rs of recordStarts) {
    console.log(`  @${rs}: hex ${ps.subarray(rs, rs+64).toString('hex')}`);
    console.log(`         ascii ${ps.subarray(rs, rs+64).toString('ascii').replace(/[^\x20-\x7e]/g, '.')}`);
}

// Show the structure around "BODY" occurrences
console.log('\n=== Context around BODY ===');
let bodyPos = 0;
let bodyCount = 0;
while ((bodyPos = ps.indexOf('BODY', bodyPos, 'ascii')) >= 0 && bodyCount < 3) {
    const start = Math.max(0, bodyPos - 32);
    const end = Math.min(ps.length, bodyPos + 64);
    console.log(`  @${bodyPos}:`);
    console.log(`    hex: ${ps.subarray(start, end).toString('hex')}`);
    console.log(`    ascii: ${ps.subarray(start, end).toString('ascii').replace(/[^\x20-\x7e]/g, '.')}`);
    bodyPos++;
    bodyCount++;
}

// Also check the smaller Parasolid section
const ps_small = (() => {
    const buf = readFileSync(join(dir, files[0]));
    let fidx = 0;
    while ((fidx = buf.indexOf(SW3D_MARKER, fidx)) >= 0) {
        if (fidx + 26 > buf.length) break;
        const fcs = buf.readUInt32LE(fidx + 14);
        const fds = buf.readUInt32LE(fidx + 18);
        const fnl = buf.readUInt32LE(fidx + 22);
        if (fnl > 0 && fnl < 1024 && fcs > 4 && fcs < buf.length && fds > 4 && fds < 500000000) {
            const fpo = fidx + 26 + fnl;
            const fpe = fpo + fcs;
            if (fpe <= buf.length) {
                try {
                    const fdec = inflateRawSync(buf.subarray(fpo, fpe), {maxOutputLength: fds + 1024});
                    if (fdec.length > 28 && fdec[28] === 0x78) {
                        try {
                            const inner = inflateSync(fdec.subarray(28));
                            if (inner.length < 5000) return inner;
                        } catch {}
                    }
                } catch {}
            }
        }
        fidx++;
    }
    return null;
})();

if (ps_small) {
    console.log('\n=== Small Parasolid section (full dump) ===');
    console.log('Size:', ps_small.length);
    // Print in hex dump format
    for (let i = 0; i < ps_small.length; i += 32) {
        const end = Math.min(i + 32, ps_small.length);
        const hex = ps_small.subarray(i, end).toString('hex').replace(/(.{2})/g, '$1 ').trim();
        const ascii = ps_small.subarray(i, end).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
        console.log(`  ${String(i).padStart(6, '0')}: ${hex.padEnd(96, ' ')} ${ascii}`);
    }
}
