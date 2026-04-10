import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const buf = readFileSync(join(dir, files[0]));

const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

// Extract section at offset 377729 (811KB main doc)  
let idx = 377729;
const cs2 = buf.readUInt32LE(idx + 14);
const ds2 = buf.readUInt32LE(idx + 18);
const nl2 = buf.readUInt32LE(idx + 22);
const po2 = idx + 26 + nl2;
const pe2 = po2 + cs2;
const dec2 = inflateRawSync(buf.subarray(po2, pe2), { maxOutputLength: ds2 + 1024 });

console.log('Main doc section: decSize', dec2.length);

// Search for geometry-related strings
const searchTerms = ['transmit', 'parasolid', 'Parasolid', 'body', 'shell', 'face', 'brep', 'BRep', 'solid', 'Solid3DBody', 'MWSolidBody', 'BodyRef'];
for (const term of searchTerms) {
    const termBuf = Buffer.from(term, 'ascii');
    const pos = dec2.indexOf(termBuf);
    if (pos >= 0) {
        const ctx = dec2.subarray(Math.max(0, pos - 20), pos + 100);
        console.log(`Found "${term}" at offset ${pos}:`);
        console.log('  ', ctx.toString('ascii').replace(/[^\x20-\x7e]/g, '.'));
        console.log();
    }
}

// Also look at section at offset 14457 (129KB)
idx = 14457;
const cs = buf.readUInt32LE(idx + 14);
const ds = buf.readUInt32LE(idx + 18);
const nl = buf.readUInt32LE(idx + 22);
const po = idx + 26 + nl;
const pe = po + cs;
const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });

console.log('\n=== Section @14457 (129KB) ===');
console.log('First 200 hex:', dec.subarray(0, 200).toString('hex'));

// Look for nested zlib in first 200 bytes
for (let i = 0; i < 200; i++) {
    if (dec[i] === 0x78 && (dec[i+1] === 0x01 || dec[i+1] === 0x9c || dec[i+1] === 0xDA || dec[i+1] === 0x5e)) {
        try {
            const d2 = inflateSync(dec.subarray(i));
            console.log(`Nested zlib at +${i}, decompressed to ${d2.length}`);
            console.log('First 200:', d2.subarray(0, 200).toString('ascii').replace(/[^\x20-\x7e]/g, '.'));
            break;
        } catch {}
    }
}

// Let's look at the section at 199443 that had all the floating point data
idx = 199443;
const cs3 = buf.readUInt32LE(idx + 14);
const ds3 = buf.readUInt32LE(idx + 18);
const nl3 = buf.readUInt32LE(idx + 22);
const po3 = idx + 26 + nl3;
const pe3 = po3 + cs3;
const dec3 = inflateRawSync(buf.subarray(po3, pe3), { maxOutputLength: ds3 + 1024 });

console.log('\n=== Section @199443 (287KB - floating point data) ===');
console.log('First 200 hex:', dec3.subarray(0, 200).toString('hex'));
// Read 10 float64 values from the start
const floats = [];
for (let i = 0; i < 80; i += 8) {
    floats.push(dec3.readDoubleLE(i));
}  
console.log('First doubles:', floats);

// Count how many uint32 and float64 values look reasonable
let validDoubles = 0;
for (let i = 0; i + 8 <= dec3.length; i += 8) {
    const v = dec3.readDoubleLE(i);
    if (isFinite(v) && Math.abs(v) < 1e10) validDoubles++;
}
console.log('Valid-looking doubles:', validDoubles, 'out of', Math.floor(dec3.length/8));
