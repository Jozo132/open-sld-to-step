import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const files = fs.readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

for (const file of files.slice(0, 3)) {
    const buf = fs.readFileSync(path.join(dir, file));
    let idx = 0;
    while ((idx = buf.indexOf(MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const compSz = buf.readUInt32LE(idx + 14);
        const decSz = buf.readUInt32LE(idx + 18);
        const namLen = buf.readUInt32LE(idx + 22);
        if (namLen > 0 && namLen < 1024 && compSz > 4 && compSz < buf.length && decSz > 4 && decSz < 5e8) {
            const off = idx + 26 + namLen;
            const end = off + compSz;
            if (end <= buf.length) {
                try {
                    const dec = zlib.inflateRawSync(buf.subarray(off, end), { maxOutputLength: decSz + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const inner = zlib.inflateSync(dec.subarray(28));
                            if (inner[0] === 0x50 && inner[1] === 0x53) {
                                let pC = 0, qC = 0;
                                for (let i = 0; i < inner.length - 1; i++) {
                                    if (inner[i] === 0x3d) {
                                        if (inner[i + 1] === 0x70) pC++;
                                        else if (inner[i + 1] === 0x71) qC++;
                                    }
                                }
                                
                                // Count how many coord triplets the naive scanner finds
                                let coordCount = 0;
                                const seen = new Set();
                                for (let i = 0; i < inner.length - 1; i++) {
                                    if (inner[i] !== 0x3d) continue;
                                    if (inner[i + 1] !== 0x70 && inner[i + 1] !== 0x71) continue;
                                    const rs = i + 2;
                                    const re = Math.min(inner.length, rs + 512);
                                    for (let j = rs; j + 24 <= re; j++) {
                                        const x = inner.readDoubleLE(j);
                                        const y = inner.readDoubleLE(j + 8);
                                        const z = inner.readDoubleLE(j + 16);
                                        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
                                        if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(z) > 1e6) continue;
                                        if (x === 0 && y === 0 && z === 0) continue;
                                        const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
                                        if (mag < 1e-15) continue;
                                        const key = `${x.toFixed(10)},${y.toFixed(10)},${z.toFixed(10)}`;
                                        if (!seen.has(key)) {
                                            seen.add(key);
                                            coordCount++;
                                        }
                                    }
                                }
                                console.log(`${file}: Parasolid ${inner.length} bytes, =p: ${pC}, =q: ${qC}, unique coords: ${coordCount}`);
                            }
                        } catch (e) { /* skip */ }
                    }
                } catch (e) { /* skip */ }
            }
        }
        idx++;
    }
}
