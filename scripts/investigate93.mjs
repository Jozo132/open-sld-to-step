/**
 * investigate93.mjs — Sentinel block primary entity → sub-record classification
 *
 * Hypothesis: Sub-record geometry entities (0x1E/0x1F) are SURFACE when
 * their sentinel block's PRIMARY entity is FACE-adjacent topology, and
 * CURVE when the primary is EDGE.
 *
 * Parse each sentinel block: find primary entity type, then classify
 * sub-record geometry entities accordingly.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

function isParasolid(buf) {
    if (buf.length < 20 || buf[0] !== 0x50 || buf[1] !== 0x53) return false;
    return buf.indexOf('TRANSMIT', 0, 'ascii') >= 0 && buf.indexOf('TRANSMIT', 0, 'ascii') < 32;
}

function getLargestPS(filePath) {
    const buf = readFileSync(filePath);
    let best = null, idx = 0;
    while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const cs = buf.readUInt32LE(idx + 14), ds = buf.readUInt32LE(idx + 18), nl = buf.readUInt32LE(idx + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50_000_000) {
            const po = idx + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (isParasolid(nested) && (!best || nested.length > best.length)) best = nested;
                        } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

function readGeomFloats(data, offset, end) {
    for (let off = offset; off < end - 1; off++) {
        const b = data[off];
        if (b !== 0x2b && b !== 0x2d) continue;
        const floats = [];
        for (let fOff = off + 1; fOff + 8 <= end; fOff += 8) {
            const v = data.readDoubleBE(fOff);
            if (!isFinite(v) || Math.abs(v) > 1e6) break;
            floats.push(v);
        }
        if (floats.length >= 3) return floats;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parse sentinel blocks and classify sub-records
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeBlocks(ps) {
    // Find all sentinel positions
    const sents = [];
    let si = 0;
    while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sents.length < 10000) { sents.push(si); si++; }

    // For each sentinel block, find the PRIMARY entity (4-byte prefix before type marker)
    // Primary header: [00 00 00 03] [00 TYPE] [ID_hi ID_lo]
    // The primary entity starts right after the previous sentinel (+ 2 bytes of 00 00)
    // and the sub-records start after the sub-record separator.

    const blockResults = [];

    for (let i = 0; i < sents.length; i++) {
        const blockStart = (i === 0) ? 0 : sents[i - 1] + SENTINEL.length;
        const blockEnd = sents[i]; // up to this sentinel
        if (blockEnd - blockStart < 10) continue;

        // Look for primary entity header [00 00 00 03] [00 TYPE] [ID:2]
        let primaryType = -1;
        let primaryId = -1;
        for (let off = blockStart; off + 8 <= blockEnd; off++) {
            if (ps[off] === 0x00 && ps[off + 1] === 0x00 && ps[off + 2] === 0x00 && ps[off + 3] === 0x03) {
                primaryType = ps[off + 5]; // [00 TYPE] → type is byte 5
                primaryId = ps.readUInt16BE(off + 6);
                break;
            }
        }

        // Look for sub-record geometry entities within this block
        let sepIdx = blockStart;
        const subRecords = [];
        while ((sepIdx = ps.indexOf(SUB_SEP, sepIdx)) >= 0 && sepIdx < blockEnd) {
            const srOff = sepIdx + SUB_SEP.length;
            if (srOff + 4 <= ps.length) {
                const srType = ps[srOff + 1]; // [00 TYPE]
                const srId = ps.readUInt16BE(srOff + 2);
                if (srType === 0x1e || srType === 0x1f) {
                    // Find the end of this sub-record (next SUB_SEP or blockEnd)
                    const nextSep = ps.indexOf(SUB_SEP, srOff);
                    const srEnd = (nextSep >= 0 && nextSep < sents[i] + SENTINEL.length) ? nextSep : sents[i];
                    const floats = readGeomFloats(ps, srOff, srEnd);
                    subRecords.push({
                        type: srType,
                        id: srId,
                        floatCount: floats ? floats.length : 0,
                        floats,
                    });
                }
            }
            sepIdx++;
        }

        if (subRecords.length > 0) {
            blockResults.push({
                primaryType,
                primaryId,
                subRecords,
            });
        }
    }

    return blockResults;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main analysis across all files
// ═══════════════════════════════════════════════════════════════════════════════

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f)).sort();

for (const fname of files) {
    const ps = getLargestPS(join(dir, fname));
    if (!ps) { console.log(`${fname}: NO PS DATA`); continue; }

    const blocks = analyzeBlocks(ps);

    // Count sub-record geometry by PRIMARY entity type
    const primaryTypeToGeom = new Map(); // primaryType → { type30_7: N, type30_11: N, type31: N, total: N }

    for (const block of blocks) {
        const pt = block.primaryType;
        if (!primaryTypeToGeom.has(pt)) {
            primaryTypeToGeom.set(pt, { type30_7: 0, type30_11: 0, type30_other: 0, type31: 0, total: 0 });
        }
        const stats = primaryTypeToGeom.get(pt);
        for (const sr of block.subRecords) {
            stats.total++;
            if (sr.type === 0x1f) {
                stats.type31++;
            } else if (sr.type === 0x1e) {
                if (sr.floatCount === 7 || sr.floatCount === 8) stats.type30_7++;
                else if (sr.floatCount >= 11) stats.type30_11++;
                else stats.type30_other++;
            }
        }
    }

    const shortName = fname.replace(/nist_|_asme.*$/g, '').toUpperCase();
    console.log(`\n=== ${shortName} ===`);
    console.log(`  Total blocks with geometry sub-records: ${blocks.length}`);

    for (const [pt, stats] of [...primaryTypeToGeom.entries()].sort((a, b) => a[0] - b[0])) {
        const ptHex = `0x${pt.toString(16).padStart(2, '0')}`;
        const ptDec = pt.toString().padStart(3);
        console.log(`  Primary type ${ptDec} (${ptHex}): total=${stats.total} 7f=${stats.type30_7} 11+f=${stats.type30_11} other=${stats.type30_other} bspl=${stats.type31}`);
    }

    // Detailed: for primary type that has 7-float sub-records, show some examples
    // to check if these are PLANE or LINE based on context
    if (primaryTypeToGeom.size > 0) {
        // For CTC_01 only, show detailed examples
        if (fname.includes('ctc_01')) {
            console.log('\n  --- Detailed sub-record examples (CTC_01) ---');
            let count = 0;
            for (const block of blocks) {
                for (const sr of block.subRecords) {
                    if (sr.floatCount === 7 && count < 15) {
                        const ptHex = `0x${block.primaryType.toString(16).padStart(2, '0')}`;
                        const dirMag = sr.floats ? Math.sqrt(sr.floats[3]**2 + sr.floats[4]**2 + sr.floats[5]**2) : 0;
                        console.log(`    7-float id=${sr.id} in primary=${ptHex}(id=${block.primaryId}) dir=[${sr.floats?.slice(3,6).map(f=>f.toFixed(4)).join(',')}] |dir|=${dirMag.toFixed(4)}`);
                        count++;
                    }
                }
            }
            count = 0;
            for (const block of blocks) {
                for (const sr of block.subRecords) {
                    if (sr.floatCount >= 11 && count < 10) {
                        const ptHex = `0x${block.primaryType.toString(16).padStart(2, '0')}`;
                        const radius = sr.floats ? sr.floats[9] : 0;
                        const semiAngle = sr.floats ? sr.floats[10] : 0;
                        console.log(`    11+f id=${sr.id} in primary=${ptHex}(id=${block.primaryId}) r=${(radius*1000).toFixed(3)}mm sA=${semiAngle.toFixed(6)}`);
                        count++;
                    }
                }
            }
        }
    }
}
