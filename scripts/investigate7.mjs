/**
 * investigate7.mjs — Find ALL Parasolid-related sections in SW3D storage
 * Clean-room analysis of public-domain NIST test files.
 *
 * The first "PS" section is only 1687 bytes (just schema+partition header).
 * The real geometry must be in another section. Let's find it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

const buf = readFileSync(join(dir, files[0]));
console.log(`File: ${files[0]} (${buf.length} bytes)\n`);

// Scan ALL sections and decompress them, checking for various signatures
let idx = 0;
let sectionNum = 0;
while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
    if (idx + 26 > buf.length) break;
    const typeId = buf.readUInt32LE(idx + 6);
    const field1 = buf.readUInt32LE(idx + 10);
    const compressedSize = buf.readUInt32LE(idx + 14);
    const decompressedSize = buf.readUInt32LE(idx + 18);
    const nameLength = buf.readUInt32LE(idx + 22);

    if (nameLength > 0 && nameLength < 1024 && compressedSize > 4 &&
        compressedSize < buf.length && decompressedSize > 4 && decompressedSize < 50_000_000) {
        const payloadOffset = idx + 26 + nameLength;
        const payloadEnd = payloadOffset + compressedSize;

        if (payloadEnd <= buf.length) {
            sectionNum++;
            try {
                const dec = inflateRawSync(buf.subarray(payloadOffset, payloadEnd),
                    { maxOutputLength: decompressedSize + 1024 });
                
                // XOR-decode metadata name
                const metaRaw = buf.subarray(idx + 26, idx + 26 + nameLength);
                const metaDec = Buffer.alloc(metaRaw.length);
                for (let i = 0; i < metaRaw.length; i++) metaDec[i] = metaRaw[i] ^ 0xFF;
                const metaName = metaDec.toString('utf8').replace(/[^\x20-\x7e]/g, '.');

                const head4 = dec.subarray(0, 4).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
                const head20 = dec.subarray(0, 20).toString('ascii').replace(/[^\x20-\x7e]/g, '.');

                // Check for nested zlib at offset 28
                let nestedInfo = '';
                if (dec.length > 28 && dec[28] === 0x78) {
                    try {
                        const inner = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                        const innerHead = inner.subarray(0, 40).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
                        nestedInfo = ` → NESTED(${inner.length}b): "${innerHead}"`;
                        
                        // Check for =p/=q in the inner buffer
                        let pCount = 0, qCount = 0;
                        for (let i = 0; i < inner.length - 1; i++) {
                            if (inner[i] === 0x3d) {
                                if (inner[i+1] === 0x70) pCount++;
                                else if (inner[i+1] === 0x71) qCount++;
                            }
                        }
                        if (pCount + qCount > 0) {
                            nestedInfo += ` [=p:${pCount} =q:${qCount}]`;
                        }
                        
                        // Check for VERTEX/POINT in inner
                        const hasVertex = inner.indexOf('VERTEX', 0, 'ascii') >= 0;
                        const hasPoint = inner.indexOf('POINT', 0, 'ascii') >= 0;
                        const hasBody = inner.indexOf('BODY', 0, 'ascii') >= 0;
                        const hasFace = inner.indexOf('FACE', 0, 'ascii') >= 0;
                        if (hasVertex || hasPoint || hasBody || hasFace) {
                            nestedInfo += ` [classes: ${hasBody?'BODY ':''}${hasFace?'FACE ':''}${hasVertex?'VERTEX ':''}${hasPoint?'POINT':''}]`;
                        }
                    } catch (e) {
                        nestedInfo = ` → nested zlib failed: ${e.message}`;
                    }
                }
                
                // Check for =p/=q in outer dec
                let pCount = 0, qCount = 0;
                for (let i = 0; i < dec.length - 1; i++) {
                    if (dec[i] === 0x3d) {
                        if (dec[i+1] === 0x70) pCount++;
                        else if (dec[i+1] === 0x71) qCount++;
                    }
                }
                
                // Check for VERTEX/POINT etc. in outer
                const hasVertex = dec.indexOf('VERTEX', 0, 'ascii') >= 0;
                const hasPoint = dec.indexOf('POINT', 0, 'ascii') >= 0;
                const hasBody = dec.indexOf('BODY', 0, 'ascii') >= 0;

                console.log(`§${sectionNum} @${idx} type:${typeId} comp:${compressedSize} dec:${dec.length} meta:"${metaName}" head:"${head20}" =p:${pCount} =q:${qCount}${hasBody?' BODY':''}${hasVertex?' VERTEX':''}${hasPoint?' POINT':''}${nestedInfo}`);
            } catch {
                console.log(`§${sectionNum} @${idx} type:${typeId} comp:${compressedSize} INFLATE_FAILED`);
            }
        }
    }
    idx++;
}

console.log(`\nTotal sections: ${sectionNum}`);

// Now let's look more carefully at the large sections with nested zlib
console.log('\n=== DETAILED: Large sections with nested content ===\n');

idx = 0;
while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
    if (idx + 26 > buf.length) break;
    const compressedSize = buf.readUInt32LE(idx + 14);
    const decompressedSize = buf.readUInt32LE(idx + 18);
    const nameLength = buf.readUInt32LE(idx + 22);
    if (nameLength > 0 && nameLength < 1024 && compressedSize > 4 &&
        compressedSize < buf.length && decompressedSize > 100_000 && decompressedSize < 50_000_000) {
        const payloadOffset = idx + 26 + nameLength;
        const payloadEnd = payloadOffset + compressedSize;
        if (payloadEnd <= buf.length) {
            try {
                const dec = inflateRawSync(buf.subarray(payloadOffset, payloadEnd),
                    { maxOutputLength: decompressedSize + 1024 });
                
                console.log(`Section @${idx} dec:${dec.length}`);
                
                // Try nested at multiple offsets
                for (const zlibOff of [0, 4, 8, 12, 16, 20, 24, 28, 32]) {
                    if (dec.length > zlibOff + 2 && dec[zlibOff] === 0x78) {
                        try {
                            const inner = inflateSync(dec.subarray(zlibOff), { maxOutputLength: 50_000_000 });
                            if (inner.length > 100) {
                                const h = inner.subarray(0, 60).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
                                console.log(`  zlib@${zlibOff}: ${inner.length}b "${h}"`);
                            }
                        } catch {}
                    }
                }
                
                // Also show the raw first 28 bytes (the header before nested zlib)
                console.log(`  Header bytes: ${[...dec.subarray(0, 32)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                console.log('');
            } catch {}
        }
    }
    idx++;
}
