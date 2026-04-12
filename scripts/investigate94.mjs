/**
 * investigate94.mjs — Correct sentinel-block entity extraction + EDGE→CURVE mapping
 *
 * Uses the same approach as ParasolidParser.extractAllEntities():
 * - Block = data AFTER sentinel, up to next sentinel
 * - Primary entity: first 4 bytes = 00000003, type at byte 5
 * - Sub-records: after SUB_RECORD_SEP, type at byte 1
 *
 * Build a map of primary entity types → sub-record geometry types.
 * For EDGE (type-0x10) primaries, read their ref fields to find
 * which sub-record geometry IDs they reference (→ CURVE).
 * Type-0x1E entities NOT referenced by any EDGE → SURFACE.
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

function readGeomFloats(data) {
    // Try all occurrences of 0x2B/0x2D, return longest valid sequence
    let best = null;
    for (const marker of [0x2b, 0x2d]) {
        let mi = -1;
        while ((mi = data.indexOf(marker, mi + 1)) >= 0) {
            if (mi + 1 + 8 > data.length) continue;
            const floats = [];
            for (let off = mi + 1; off + 8 <= data.length; off += 8) {
                const v = data.readDoubleBE(off);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                floats.push(v);
            }
            if (floats.length >= 3 && (!best || floats.length > best.length)) {
                best = floats;
            }
        }
    }
    return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parse all sentinel blocks correctly (matching ParasolidParser.extractAllEntities)
// ═══════════════════════════════════════════════════════════════════════════════

function parseAllEntities(ps) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx += SENTINEL.length; }
    if (sentPositions.length === 0) return { entities: [], blocks: [] };

    const entities = [];
    const blocks = [];

    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + SENTINEL.length;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        // Split by SUB_RECORD_SEP
        const subRecords = [];
        let searchStart = 0;
        while (true) {
            const sepIdx = block.indexOf(SUB_SEP, searchStart);
            if (sepIdx < 0) { subRecords.push(block.subarray(searchStart)); break; }
            subRecords.push(block.subarray(searchStart, sepIdx));
            searchStart = sepIdx + SUB_SEP.length;
        }

        let primaryType = -1, primaryId = -1;
        const blockEntities = [];

        for (let si = 0; si < subRecords.length; si++) {
            const rec = subRecords[si];
            if (si === 0) {
                // Primary: [00 00 00 03 00 TYPE ID_hi ID_lo]
                if (rec.length < 8) continue;
                if (rec.readUInt32BE(0) !== 3) continue;
                const type = rec[5];
                if (type < 0x0d || type > 0x3f) continue;
                const id = rec.readUInt16BE(6);
                primaryType = type;
                primaryId = id;
                entities.push({ type, id, data: rec.subarray(8), isPrimary: true });
                blockEntities.push({ type, id, isPrimary: true });
            } else {
                // Sub-record: [00 TYPE ID_hi ID_lo]
                if (rec.length < 4 || rec[0] !== 0x00) continue;
                const type = rec[1];
                if (type < 0x0d || type > 0x3f) continue;
                const id = rec.readUInt16BE(2);
                const data = rec.subarray(4);
                const floats = (type === 0x1e || type === 0x1f) ? readGeomFloats(data) : null;
                entities.push({ type, id, data, isPrimary: false, floats });
                blockEntities.push({ type, id, isPrimary: false, floatCount: floats ? floats.length : 0 });
            }
        }

        if (blockEntities.length > 0) {
            blocks.push({ primaryType, primaryId, entities: blockEntities });
        }
    }

    return { entities, blocks };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main analysis
// ═══════════════════════════════════════════════════════════════════════════════

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f)).sort();

for (const fname of files) {
    const ps = getLargestPS(join(dir, fname));
    if (!ps) { console.log(`${fname}: NO PS DATA`); continue; }

    const { entities, blocks } = parseAllEntities(ps);

    // Group entities by type
    const byType = new Map();
    for (const e of entities) {
        if (!byType.has(e.type)) byType.set(e.type, []);
        byType.get(e.type).push(e);
    }

    // Classify blocks by primary type → what geometry sub-records they contain
    const primaryToGeom = new Map();
    for (const block of blocks) {
        const pt = block.primaryType;
        if (!primaryToGeom.has(pt)) primaryToGeom.set(pt, { total: 0, geom7: 0, geom11: 0, geomOther: 0, bspl: 0 });
        const stats = primaryToGeom.get(pt);
        for (const e of block.entities) {
            if (e.isPrimary) continue;
            if (e.type === 0x1e) {
                stats.total++;
                if (e.floatCount === 7 || e.floatCount === 8) stats.geom7++;
                else if (e.floatCount >= 11) stats.geom11++;
                else stats.geomOther++;
            } else if (e.type === 0x1f) {
                stats.total++;
                stats.bspl++;
            }
        }
    }

    // Collect geometry entity IDs (type-0x1E and 0x1F sub-records)
    const geomEntities = new Map(); // id → { type, floatCount }
    for (const e of entities) {
        if (!e.isPrimary && (e.type === 0x1e || e.type === 0x1f)) {
            const floats = e.floats || readGeomFloats(e.data);
            geomEntities.set(e.id, { type: e.type, floatCount: floats ? floats.length : 0 });
        }
    }

    // Collect EDGE entities (primary type-0x10) and their reference fields
    const edgeReferencedGeom = new Set();
    const edgeEntities = entities.filter(e => e.isPrimary && e.type === 0x10);
    for (const e of edgeEntities) {
        // EDGE data: contains int16 reference fields
        // From investigate20: refs[3] → CURVE geometry
        // Read multiple ref positions and check which point to geometry entities
        for (let off = 0; off + 2 <= e.data.length && off < 20; off += 2) {
            const refId = e.data.readUInt16BE(off);
            if (geomEntities.has(refId)) {
                edgeReferencedGeom.add(refId);
            }
        }
    }

    // Also check COEDGE (0x12) and FACE (0x0F) primary entities for geometry refs
    const faceReferencedGeom = new Set();
    const faceEntities = entities.filter(e => e.isPrimary && e.type === 0x0f);
    for (const e of faceEntities) {
        for (let off = 0; off + 2 <= e.data.length && off < 30; off += 2) {
            const refId = e.data.readUInt16BE(off);
            if (geomEntities.has(refId)) {
                faceReferencedGeom.add(refId);
            }
        }
    }

    // Classify geometry entities
    let edgeOnly = 0, faceOnly = 0, both = 0, neither = 0;
    let edgeOnly7 = 0, faceOnly7 = 0, neither7 = 0, both7 = 0;
    let edgeOnly11 = 0, faceOnly11 = 0, neither11 = 0;
    const neitherEntities = []; // for detailed inspection

    for (const [id, geom] of geomEntities) {
        const byEdge = edgeReferencedGeom.has(id);
        const byFace = faceReferencedGeom.has(id);
        const nf = geom.floatCount;

        if (byEdge && !byFace) {
            edgeOnly++;
            if (nf === 7 || nf === 8) edgeOnly7++;
            if (nf >= 11) edgeOnly11++;
        } else if (byFace && !byEdge) {
            faceOnly++;
            if (nf === 7 || nf === 8) faceOnly7++;
            if (nf >= 11) faceOnly11++;
        } else if (byEdge && byFace) {
            both++;
            if (nf === 7 || nf === 8) both7++;
        } else {
            neither++;
            if (nf === 7 || nf === 8) neither7++;
            if (nf >= 11) neither11++;
            neitherEntities.push({ id, ...geom });
        }
    }

    const shortName = fname.replace(/nist_|_asme.*$/g, '').toUpperCase();
    console.log(`\n=== ${shortName} ===`);
    console.log(`  Entities: total=${entities.length} PRIMARY: FACE(0F)=${faceEntities.length} EDGE(10)=${edgeEntities.length}`);
    console.log(`  Geometry sub-records: total=${geomEntities.size} (type-0x1E: ${[...geomEntities.values()].filter(g=>g.type===0x1e).length}, type-0x1F: ${[...geomEntities.values()].filter(g=>g.type===0x1f).length})`);
    console.log(`  Edge-referenced: ${edgeOnly} (7f=${edgeOnly7}, 11+f=${edgeOnly11})`);
    console.log(`  Face-referenced: ${faceOnly} (7f=${faceOnly7}, 11+f=${faceOnly11})`);
    console.log(`  Both: ${both} (7f=${both7})`);
    console.log(`  Neither: ${neither} (7f=${neither7}, 11+f=${neither11})`);

    // Show primary type → sub-record geometry mapping
    console.log(`  Block primary types with geometry:`);
    for (const [pt, stats] of [...primaryToGeom.entries()].sort((a, b) => a[0] - b[0])) {
        if (stats.total === 0) continue;
        const hex = pt >= 0 ? `0x${pt.toString(16).padStart(2, '0')}` : 'none';
        console.log(`    ${hex}: ${stats.total} geom (7f=${stats.geom7} 11+f=${stats.geom11} other=${stats.geomOther} bspl=${stats.bspl})`);
    }

    // Show "neither" examples for first file
    if (neitherEntities.length > 0 && fname.includes('ctc_01')) {
        console.log(`  Neither entities (not EDGE/FACE referenced):`);
        for (const e of neitherEntities.slice(0, 15)) {
            console.log(`    id=${e.id} type=0x${e.type.toString(16)} floats=${e.floatCount}`);
        }
    }
}
