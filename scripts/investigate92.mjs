/**
 * investigate92.mjs — Topology-based LINE/PLANE classification
 *
 * Hypothesis: type-0x1E (30) entities that are CURVES (LINE/CIRCLE) are
 * referenced by EDGE (type-16) entities. Those that are SURFACES (PLANE/
 * CYLINDER) are referenced by FACE (type-15) entities.
 *
 * Build a complete entity map, then for each type-30 entity check who
 * references it. Cross-reference with float count to validate.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Build complete entity map from Parasolid binary
// ═══════════════════════════════════════════════════════════════════════════════

function buildEntityMap(ps) {
    const entities = new Map();
    const sentinels = [];
    let si = 0;
    while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 10000) { sentinels.push(si); si++; }

    // 1. FF-marked entities (pre-sentinel zone)
    for (let off = 0; off < ps.length - 11; off++) {
        if (ps[off + 2] !== 0xFF) continue;
        const type = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 3);
        const z = ps.readUInt16BE(off + 5);
        const flags = ps.readUInt16BE(off + 7);
        const one = ps.readUInt16BE(off + 9);
        if (z !== 0 || one !== 1 || type < 1 || type > 200 || id < 1 || id > 10000) continue;
        if (entities.has(id)) continue;
        // Read refs starting at off+11
        const refs = [];
        for (let j = 0; j < 10; j++) {
            const o = off + 11 + j * 2;
            if (o + 2 <= ps.length) refs.push(ps.readUInt16BE(o));
        }
        entities.set(id, { type, id, flags, offset: off, refs, format: 'ff' });
    }

    // 2. Type-18 (COEDGE) — 18B before sentinel
    for (const sentOff of sentinels) {
        const off = sentOff - 18;
        if (off < 0) continue;
        const t = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const z = ps.readUInt16BE(off + 4);
        const flags = ps.readUInt16BE(off + 6);
        const o = ps.readUInt16BE(off + 8);
        if (t !== 18 || z !== 0 || o !== 1 || id < 1 || id > 10000) continue;
        if (entities.has(id)) continue;
        const refs = [];
        for (let j = 0; j < 4; j++) refs.push(ps.readUInt16BE(off + 10 + j * 2));
        entities.set(id, { type: 18, id, flags, offset: off, refs, format: 'sent-18' });
    }

    // 3. Type-16 (EDGE) — 10B before sentinel (sentinel inside entity data)
    for (const sentOff of sentinels) {
        const off = sentOff - 10;
        if (off < 0) continue;
        const t = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const z = ps.readUInt16BE(off + 4);
        const flags = ps.readUInt16BE(off + 6);
        const o = ps.readUInt16BE(off + 8);
        if (t !== 16 || z !== 0 || o !== 1 || id < 1 || id > 10000) continue;
        if (entities.has(id)) continue;
        // Data starts after the sentinel (the sentinel is embedded in the edge record)
        const dataOff = sentOff + 8;
        const refs = [];
        for (let j = 0; j < 8; j++) {
            const ro = dataOff + j * 2;
            if (ro + 2 <= ps.length) refs.push(ps.readUInt16BE(ro));
        }
        entities.set(id, { type: 16, id, flags, offset: off, refs, format: 'sent-16', dataOffset: dataOff });
    }

    // 4. Type-29 (POINT) — in gap after sentinel
    for (const sentOff of sentinels) {
        const gapStart = sentOff + 8;
        if (gapStart + 42 > ps.length) continue;
        const sep = ps.readUInt16BE(gapStart);
        const t = ps.readUInt16BE(gapStart + 2);
        const id = ps.readUInt16BE(gapStart + 4);
        const z = ps.readUInt16BE(gapStart + 6);
        const flags = ps.readUInt16BE(gapStart + 8);
        const o = ps.readUInt16BE(gapStart + 10);
        if (t !== 29 || z !== 0 || o !== 1 || id < 1 || id > 10000) continue;
        if (entities.has(id)) continue;
        const refs = [];
        for (let j = 0; j < 3; j++) refs.push(ps.readUInt16BE(gapStart + 12 + j * 2));
        entities.set(id, { type: 29, id, flags, offset: gapStart + 2, refs, format: 'gap-29' });
    }

    // 5. General scan for type-15 (FACE), 30 (SURFACE/CURVE), 31 (BSPLINE), 19 (LOOP), etc.
    for (let off = 0; off < ps.length - 30; off++) {
        const t = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const z = ps.readUInt16BE(off + 4);
        const flags = ps.readUInt16BE(off + 6);
        const o = ps.readUInt16BE(off + 8);
        if (z !== 0 || o !== 1) continue;
        if (t < 1 || t > 200 || id < 1 || id > 10000) continue;
        if (entities.has(id)) continue;
        if (![15, 19, 30, 31, 50, 51, 17].includes(t)) continue;
        const refs = [];
        for (let j = 0; j < 12; j++) {
            const ro = off + 10 + j * 2;
            if (ro + 2 <= ps.length) refs.push(ps.readUInt16BE(ro));
        }
        entities.set(id, { type: t, id, flags, offset: off, refs, format: 'scan' });
    }

    return { entities, sentinels };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Read geometry floats from a type-30 entity
// ═══════════════════════════════════════════════════════════════════════════════
function getGeomFloats(ps, entity) {
    // Sub-record entities (type-30, 31) are embedded in sentinel blocks.
    // Scan forward from entity offset for 0x2B/0x2D marker, then read float64s.
    const start = entity.offset;
    const end = Math.min(start + 200, ps.length);
    for (let off = start; off < end - 1; off++) {
        const b = ps[off];
        if (b !== 0x2b && b !== 0x2d) continue;
        const floats = [];
        for (let fOff = off + 1; fOff + 8 <= ps.length; fOff += 8) {
            const v = ps.readDoubleBE(fOff);
            if (!isFinite(v) || Math.abs(v) > 1e6) break;
            floats.push(v);
        }
        if (floats.length >= 3) return floats;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main analysis
// ═══════════════════════════════════════════════════════════════════════════════

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f)).sort();

for (const fname of files) {
    const ps = getLargestPS(join(dir, fname));
    if (!ps) { console.log(`${fname}: NO PS DATA`); continue; }

    const { entities } = buildEntityMap(ps);

    // Group by type
    const byType = new Map();
    for (const e of entities.values()) {
        if (!byType.has(e.type)) byType.set(e.type, []);
        byType.get(e.type).push(e);
    }

    const type15 = byType.get(15) || []; // FACE
    const type16 = byType.get(16) || []; // EDGE
    const type30 = byType.get(30) || []; // SURFACE/CURVE
    const type31 = byType.get(31) || []; // BSPLINE

    // Build "referenced-by" map for type-30 and type-31 entities
    const referencedBy = new Map(); // entity ID → Set of {type, refIndex}

    // Check type-16 (EDGE) → which type-30/31 they reference
    for (const e of type16) {
        for (let ri = 0; ri < e.refs.length; ri++) {
            const refId = e.refs[ri];
            const target = entities.get(refId);
            if (target && (target.type === 30 || target.type === 31)) {
                if (!referencedBy.has(refId)) referencedBy.set(refId, []);
                referencedBy.get(refId).push({ byType: 16, refIndex: ri, byId: e.id });
            }
        }
    }

    // Check type-15 (FACE) → which type-30/31 they reference
    for (const e of type15) {
        for (let ri = 0; ri < e.refs.length; ri++) {
            const refId = e.refs[ri];
            const target = entities.get(refId);
            if (target && (target.type === 30 || target.type === 31)) {
                if (!referencedBy.has(refId)) referencedBy.set(refId, []);
                referencedBy.get(refId).push({ byType: 15, refIndex: ri, byId: e.id });
            }
        }
    }

    // Classify type-30 entities
    let edgeOnly = 0, faceOnly = 0, both = 0, neither = 0;
    let edgeOnly7 = 0, faceOnly7 = 0, edgeOnly11 = 0, faceOnly11 = 0;
    const edgeRefIndices = new Map(); // refIndex → count
    const faceRefIndices = new Map();

    for (const e of type30) {
        const refs = referencedBy.get(e.id) || [];
        const byEdge = refs.filter(r => r.byType === 16);
        const byFace = refs.filter(r => r.byType === 15);

        const floats = getGeomFloats(ps, e);
        const nf = floats ? floats.length : 0;

        if (byEdge.length > 0 && byFace.length === 0) {
            edgeOnly++;
            if (nf === 7) edgeOnly7++;
            if (nf >= 11) edgeOnly11++;
            for (const r of byEdge) edgeRefIndices.set(r.refIndex, (edgeRefIndices.get(r.refIndex) || 0) + 1);
        } else if (byFace.length > 0 && byEdge.length === 0) {
            faceOnly++;
            if (nf === 7) faceOnly7++;
            if (nf >= 11) faceOnly11++;
            for (const r of byFace) faceRefIndices.set(r.refIndex, (faceRefIndices.get(r.refIndex) || 0) + 1);
        } else if (byEdge.length > 0 && byFace.length > 0) {
            both++;
        } else {
            neither++;
        }
    }

    // Same for type-31
    let t31_edgeOnly = 0, t31_faceOnly = 0, t31_both = 0, t31_neither = 0;
    for (const e of type31) {
        const refs = referencedBy.get(e.id) || [];
        const byEdge = refs.filter(r => r.byType === 16);
        const byFace = refs.filter(r => r.byType === 15);
        if (byEdge.length > 0 && byFace.length === 0) t31_edgeOnly++;
        else if (byFace.length > 0 && byEdge.length === 0) t31_faceOnly++;
        else if (byEdge.length > 0 && byFace.length > 0) t31_both++;
        else t31_neither++;
    }

    const shortName = fname.replace(/nist_|_asme.*$/g, '').toUpperCase();
    console.log(`\n=== ${shortName} (${fname}) ===`);
    console.log(`  Entities: total=${entities.size} FACE(15)=${type15.length} EDGE(16)=${type16.length} GEOM(30)=${type30.length} BSPL(31)=${type31.length}`);
    console.log(`  Type-30 referenced by: EDGE-only=${edgeOnly} FACE-only=${faceOnly} BOTH=${both} NEITHER=${neither}`);
    console.log(`    7-float (LINE/PLANE): EDGE-ref=${edgeOnly7} FACE-ref=${faceOnly7}`);
    console.log(`    11+-float (CYL/CONE): EDGE-ref=${edgeOnly11} FACE-ref=${faceOnly11}`);
    console.log(`  Type-31 referenced by: EDGE-only=${t31_edgeOnly} FACE-only=${t31_faceOnly} BOTH=${t31_both} NEITHER=${t31_neither}`);
    console.log(`  EDGE→GEOM ref indices: ${[...edgeRefIndices.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`[${k}]=${v}`).join(' ')}`);
    console.log(`  FACE→GEOM ref indices: ${[...faceRefIndices.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`[${k}]=${v}`).join(' ')}`);
}
