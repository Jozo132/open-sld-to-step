import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const buf = readFileSync(join(dir, files[0]));

const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

// Extract section at offset 14457, then double-decompress
let idx = 14457;
const cs = buf.readUInt32LE(idx + 14);
const ds = buf.readUInt32LE(idx + 18);
const nl = buf.readUInt32LE(idx + 22);
const po = idx + 26 + nl;
const pe = po + cs;
const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });

console.log('Outer header (28 bytes hex):', dec.subarray(0, 28).toString('hex'));
console.log('Outer header as u32:', [
    dec.readUInt32LE(0), dec.readUInt32LE(4), dec.readUInt32LE(8),
    dec.readUInt32LE(12), dec.readUInt32LE(16), dec.readUInt32LE(20),
    dec.readUInt32LE(24)
]);

const inner = inflateSync(dec.subarray(28));
console.log('Inner decompressed size:', inner.length);

// Show first 2000 chars of the Parasolid text
const text = inner.subarray(0, 2000).toString('ascii');
console.log('\n=== Parasolid text (first 2000 chars) ===');
console.log(text);

// Show last 500 chars
console.log('\n=== Parasolid text (last 500 chars) ===');
console.log(inner.subarray(Math.max(0, inner.length - 500)).toString('ascii'));

// Save to file for inspection  
writeFileSync('downloads/nist_ctc_01_parasolid.x_t', inner);
console.log('\nSaved to downloads/nist_ctc_01_parasolid.x_t');

// Now check ALL files to see if they all have this pattern
console.log('\n=== Checking all SLDPRT files ===');
for (const file of files) {
    const fbuf = readFileSync(join(dir, file));
    let found = false;
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
                    // Look for nested zlib starting around offset 20-32
                    for (let zoff = 20; zoff < Math.min(fdec.length, 40); zoff++) {
                        if (fdec[zoff] === 0x78 && (fdec[zoff+1] === 0x01 || fdec[zoff+1] === 0x9c || fdec[zoff+1] === 0xDA)) {
                            try {
                                const inner2 = inflateSync(fdec.subarray(zoff));
                                const head = inner2.subarray(0, 30).toString('ascii');
                                if (head.includes('TRANSMIT') || head.includes('PS')) {
                                    console.log(`${file}: Found Parasolid at section@${fidx}, zlibOff=${zoff}, innerSize=${inner2.length}, head="${head.replace(/[^\x20-\x7e]/g, '.')}"`)  ;
                                    found = true;
                                    break;
                                }
                            } catch {}
                        }
                    }
                    if (found) break;
                } catch {}
            }
        }
        fidx++;
    }
    if (!found) console.log(`${file}: NO Parasolid found`);
}
