/**
 * investigate21.mjs — Find the "unknown" entities in 99-byte blocks
 *
 * Between consecutive sentinels, we have blocks of 68B (type-18→type-29)
 * and larger blocks (99B, 131B, etc.) that contain additional entities.
 * 
 * The "unknown" entities are referenced by:
 *   - Type-18 ref[0] (e.g., entities 59, 67, 72, 75...)
 *   - Type-16 ref[0] (all 359 unknown)
 * 
 * These must be in the variable-size blocks between type-16 sentinels
 * and type-18 sentinels.
 *
 * Strategy: Walk the sentinel zone sequentially, identifying EVERY entity
 * by offset. The zone alternates: [type-16 + data] [other entities] [type-18 + sentinel] [type-29 gap]
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

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

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const fname = files.find(f => f.startsWith('nist_ctc_01'));
const ps = getLargestPS(join(dir, fname));
console.log(`File: ${fname}, buffer: ${ps.length} bytes\n`);

// Find all sentinels  
const sentinels = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 5000) { sentinels.push(si); si++; }

// Classify sentinels
const sentInfo = sentinels.map(off => {
    // Check if preceded by type-18 at -18
    const t18off = off - 18;
    if (t18off >= 0) {
        const t = ps.readUInt16BE(t18off);
        const o = ps.readUInt16BE(t18off + 8);
        if (t === 18 && o === 1) {
            const id = ps.readUInt16BE(t18off + 2);
            return { type: 'type18', sentOff: off, entityOff: t18off, entityId: id };
        }
    }
    // Check if preceded by type-16 at -10
    const t16off = off - 10;
    if (t16off >= 0) {
        const t = ps.readUInt16BE(t16off);
        const o = ps.readUInt16BE(t16off + 8);
        if (t === 16 && o === 1) {
            const id = ps.readUInt16BE(t16off + 2);
            return { type: 'type16', sentOff: off, entityOff: t16off, entityId: id };
        }
    }
    return { type: 'other', sentOff: off };
});

// ═══════════════════════════════════════════════════════════════════════════════
// Walk sentinel zone sequentially
// ═══════════════════════════════════════════════════════════════════════════════

console.log('=== SEQUENTIAL SENTINEL ZONE WALK (first 30 sentinels) ===\n');

function hexRange(buf, start, len) {
    const bytes = [];
    for (let j = 0; j < len && start + j < buf.length; j++) {
        bytes.push(buf[start + j].toString(16).padStart(2, '0'));
    }
    return bytes.join(' ');
}

for (let i = 0; i < Math.min(30, sentInfo.length); i++) {
    const s = sentInfo[i];
    const nextSent = (i + 1 < sentInfo.length) ? sentInfo[i + 1] : null;
    const endOfData = s.sentOff + 8; // end of sentinel bytes
    const nextStart = nextSent ? nextSent.entityOff || nextSent.sentOff : ps.length;
    const gapSize = nextStart - endOfData;
    
    console.log(`Sentinel ${i}: ${s.type} id=${s.entityId || '?'} @0x${s.sentOff.toString(16)} gap=${gapSize}B`);
    
    // Dump the gap between this sentinel and the next entity
    if (gapSize > 0 && gapSize < 200) {
        console.log(`  Gap data (${gapSize}B): ${hexRange(ps, endOfData, Math.min(gapSize, 80))}`);
        
        // Scan for entity headers in the gap
        for (let off = endOfData; off < nextStart - 10; off++) {
            const t = ps.readUInt16BE(off);
            const id = ps.readUInt16BE(off + 2);
            const z = ps.readUInt16BE(off + 4);
            const flags = ps.readUInt16BE(off + 6);
            const o = ps.readUInt16BE(off + 8);
            if (z === 0 && o === 1 && t > 0 && t <= 200 && id > 0 && id < 10000) {
                const relOff = off - endOfData;
                console.log(`  → Entity at +${relOff}: type=${t} id=${id} flags=0x${flags.toString(16)}`);
            }
        }
        
        // Also check for the ff-format in the gap
        for (let off = endOfData; off < nextStart - 11; off++) {
            if (ps[off + 2] !== 0xFF) continue;
            const t = ps.readUInt16BE(off);
            const id = ps.readUInt16BE(off + 3);
            const z = ps.readUInt16BE(off + 5);
            const flags = ps.readUInt16BE(off + 7);
            const o = ps.readUInt16BE(off + 9);
            if (z === 0 && o === 1 && t > 0 && t <= 200 && id > 0 && id < 10000) {
                const relOff = off - endOfData;
                console.log(`  → FF-entity at +${relOff}: type=${t} id=${id} flags=0x${flags.toString(16)}`);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOCUSED: find what's between type-16 sentinel and type-18 sentinel
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-16 → TYPE-18 INTERMEDIATE ENTITIES ===\n');

// Find pairs: type-16 sentinel followed by type-18 sentinel
const t16_t18_pairs = [];
for (let i = 0; i < sentInfo.length - 1; i++) {
    if (sentInfo[i].type === 'type16' && sentInfo[i + 1].type === 'type18') {
        t16_t18_pairs.push({ t16: sentInfo[i], t18: sentInfo[i + 1] });
    }
}

console.log(`Type-16 → Type-18 sentinel pairs: ${t16_t18_pairs.length}`);

// Analyze the intermediate data
const intermediatePatterns = new Map();
for (const pair of t16_t18_pairs) {
    const gapStart = pair.t16.sentOff + 8; // after type-16 sentinel
    const gapEnd = pair.t18.entityOff; // before type-18 entity header
    const gapSize = gapEnd - gapStart;
    
    // Read first 2 bytes to identify pattern
    if (gapSize > 4) {
        const firstByte = ps.readUInt16BE(gapStart);
        const secondByte = ps.readUInt16BE(gapStart + 2);
        
        // Scan for compact headers in the gap
        const entities = [];
        for (let off = gapStart; off < gapEnd - 10; off++) {
            const t = ps.readUInt16BE(off);
            const id = ps.readUInt16BE(off + 2);
            const z = ps.readUInt16BE(off + 4);
            const flags = ps.readUInt16BE(off + 6);
            const o = ps.readUInt16BE(off + 8);
            if (z === 0 && o === 1 && t > 0 && t <= 200 && id > 0 && id < 5000) {
                entities.push({ type: t, id, offset: off - gapStart });
                off += 9;
            }
        }
        
        const types = entities.map(e => `t${e.type}`).join('+');
        const key = `gap=${gapSize} entities=[${types}]`;
        intermediatePatterns.set(key, (intermediatePatterns.get(key) || 0) + 1);
    }
}

console.log('\nType-16 → Type-18 gap patterns:');
for (const [key, count] of [...intermediatePatterns.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`);
}

// Show a few examples of the intermediate data
console.log('\nExamples:');
for (const pair of t16_t18_pairs.slice(0, 8)) {
    const gapStart = pair.t16.sentOff + 8;
    const gapEnd = pair.t18.entityOff;
    const gapSize = gapEnd - gapStart;
    
    console.log(`\n  Edge ${pair.t16.entityId} → Coedge ${pair.t18.entityId} (${gapSize}B gap)`);
    console.log(`  Data: ${hexRange(ps, gapStart, Math.min(gapSize, 60))}`);
    
    // Try to decode the gap
    const entities = [];
    for (let off = gapStart; off < gapEnd - 10; off++) {
        const t = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const z = ps.readUInt16BE(off + 4);
        const flags = ps.readUInt16BE(off + 6);
        const o = ps.readUInt16BE(off + 8);
        if (z === 0 && o === 1 && t > 0 && t <= 200 && id > 0 && id < 5000) {
            entities.push({ type: t, id, flags, offset: off - gapStart });
        }
    }
    for (const e of entities) {
        console.log(`    type=${e.type} id=${e.id} flags=0x${e.flags.toString(16)} @+${e.offset}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Look for entities with 2b/2d marker bytes (like type-29/30/31)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== MARKER BYTE ANALYSIS ===\n');

// After the header and 4 refs, entities have a marker byte (0x2b or 0x2d)
// This might indicate the presence/absence of additional float64 data
// 0x2b = '+' in ASCII, 0x2d = '-' in ASCII

// Count marker bytes across all entity types
const markerByType = new Map();
for (let off = 0; off < ps.length - 20; off++) {
    const t = ps.readUInt16BE(off);
    const id = ps.readUInt16BE(off + 2);
    const z = ps.readUInt16BE(off + 4);
    const flags = ps.readUInt16BE(off + 6);
    const o = ps.readUInt16BE(off + 8);
    
    if (z !== 0 || o !== 1) continue;
    if (t < 1 || t > 200 || id < 1 || id > 10000) continue;
    
    // Check byte at offset + 18 (after header + 4 refs)
    if (off + 18 < ps.length) {
        const marker = ps[off + 18];
        if (marker === 0x2b || marker === 0x2d) {
            const key = `type=${t} marker=0x${marker.toString(16)}`;
            markerByType.set(key, (markerByType.get(key) || 0) + 1);
        }
    }
}

console.log('Entity type + marker byte at +18:');
for (const [k, v] of [...markerByType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${k}: ${v}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Look at the bytes BETWEEN type-16 data and type-18 header
// WITHOUT the standard header pattern
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== RAW GAP STRUCTURE (type-16 post-data → type-18 pre-header) ===\n');

// For the first 10 t16→t18 pairs, decode EXACTLY what's in the gap
for (const pair of t16_t18_pairs.slice(0, 10)) {
    const gapStart = pair.t16.sentOff + 8; // After type-16 sentinel
    const gapEnd = pair.t18.entityOff;      // Before type-18 header
    const gapSize = gapEnd - gapStart;
    
    // Type-16 entity: [header:10B] [sentinel:8B] [post-sentinel data...]
    // Post-sentinel data for type-16 = refs [ref1:2, ref2:2, ref3:2, ref4:2, ref5:2, ref6:2]
    // That's 12 bytes of refs after the sentinel
    
    // Read type-16 refs
    const t16Refs = [];
    for (let j = 0; j < 6; j++) t16Refs.push(ps.readUInt16BE(gapStart + j * 2));
    
    const t16PostRefStart = gapStart + 12; // After 6 refs
    const t16ToT18Gap = gapEnd - t16PostRefStart;
    
    // Read type-18 entity's ref[0] (the "unknown" reference)
    const t18Ref0 = ps.readUInt16BE(pair.t18.entityOff + 10);
    
    console.log(`  Edge ${pair.t16.entityId} refs=[${t16Refs.join(',')}]`);
    console.log(`  Coedge ${pair.t18.entityId} ref0=${t18Ref0}`);
    console.log(`  Post-ref gap: ${t16ToT18Gap}B`);
    if (t16ToT18Gap > 0 && t16ToT18Gap < 100) {
        console.log(`  Data: ${hexRange(ps, t16PostRefStart, Math.min(t16ToT18Gap, 80))}`);
    }
    
    // Check: does the gap contain an entity header for t18Ref0?
    for (let off = t16PostRefStart; off < gapEnd - 10; off++) {
        const id = ps.readUInt16BE(off + 2);
        if (id === t18Ref0) {
            const t = ps.readUInt16BE(off);
            const z = ps.readUInt16BE(off + 4);
            const o = ps.readUInt16BE(off + 8);
            console.log(`  FOUND ref0 entity ${t18Ref0} at +${off-t16PostRefStart}: type=${t} z=${z} one=${o}`);
        }
    }
    console.log();
}
