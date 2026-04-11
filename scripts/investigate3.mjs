/**
 * investigate3.mjs
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

// Check ALL parasolid sections per file, picking the largest
for (const file of files) {
    const fbuf = readFileSync(join(dir, file));
    const found = [];
    let fidx = 0;
    while ((fidx = fbuf.indexOf(SW3D_MARKER, fidx)) >= 0) {
        if (fidx + 26 > fbuf.length) break;
        const fcs = fbuf.readUInt32LE(fidx + 14);
        const fds = fbuf.readUInt32LE(fidx + 18);
        const fnl = fbuf.readUInt32LE(fidx + 22);
        if (fnl > 0 && fnl < 1024 && fcs > 4 && fcs < fbuf.length && fds > 4 && fds < 500000000) {
            const fpo = fidx + 26 + fnl;
            const fpe = fpo + fcs;
            if (fpe <= fbuf.length) {
                try {
                    const fdec = inflateRawSync(fbuf.subarray(fpo, fpe), { maxOutputLength: fds + 1024 });
                    // Check offset 28 for nested zlib
                    if (fdec.length > 30 && fdec[28] === 0x78) {
                        try {
                            const inner = inflateSync(fdec.subarray(28));
                            const head = inner.subarray(0, 40).toString('ascii');
                            if (head.includes('TRANSMIT') || head.includes('PS')) {
                                found.push({ offset: fidx, size: inner.length, head: head.replace(/[^\x20-\x7e]/g, '.') });
                            }
                        } catch {}
                    }
                } catch {}
            }
        }
        fidx++;
    }
    console.log(`${file}: ${found.length} Parasolid sections`);
    for (const f of found) {
        console.log(`  @${f.offset} size=${f.size} head="${f.head.substring(0, 40)}"`);
    }
}

// Show detailed Parasolid structure of first file's largest section
const buf = readFileSync(join(dir, files[0]));
let idx = 14457;
const cs = buf.readUInt32LE(idx + 14);
const ds = buf.readUInt32LE(idx + 18);
const nl = buf.readUInt32LE(idx + 22);
const dec = inflateRawSync(buf.subarray(idx + 26 + nl, idx + 26 + nl + cs), { maxOutputLength: ds + 1024 });
const inner = inflateSync(dec.subarray(28));
const text = inner.toString('latin1');

// Parse the Parasolid text structure - find key elements
console.log('\n=== Parasolid text format analysis ===');
console.log('Total length:', text.length);

// The Parasolid text format uses record-based structure
// Look for key entity tokens
const tokens = ['BODY', 'SHELL', 'FACE', 'LOOP', 'EDGE', 'FIN', 'VERTEX', 'POINT', 'CURVE', 'SURFACE', 'PLANE', 'CYLINDER', 'CONE', 'SPHERE', 'TORUS', 'BSURF', 'LINE', 'CIRCLE', 'BCURV', 'ATTRIB', 'REGION', 'LUMP'];
for (const tok of tokens) {
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(tok, pos)) >= 0) { count++; pos++; }
    if (count > 0) console.log(`  ${tok}: ${count} occurrences`);
}

// Show the first major Parasolid text section structure
// The PS/x_t format starts with header lines then uses a schema-based notation
const lines = text.split('\n');
console.log(`\nFirst 50 non-empty chars per line (first 30 lines):`);
for (let i = 0; i < Math.min(30, lines.length); i++) {
    const cleaned = lines[i].replace(/[^\x20-\x7e]/g, '.').substring(0, 60);
    if (cleaned.trim()) console.log(`  L${i}: "${cleaned}"`);
}
