/**
 * investigate19.mjs — Map the complete BLOCK structure between sentinels
 *
 * Hypothesis: Each "block" in the sentinel zone contains:
 *   1. Type-16 entity (EDGE): 10B header + sentinel_as_data + more refs
 *   2. Optional type-30/31 entities (SURFACE/CURVE data)
 *   3. Type-15 entity (LOOP): refs to edges
 *   4. Type-18 entity (COEDGE): 18B header + sentinel terminator
 *   5. Type-29 entity (POINT): 40B with coordinates in the gap
 *
 * Also: Parse the ff-marked records (entities 7-14) to find BODY/SHELL/FACE structure
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
while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 5000) {
    sentinels.push(si);
    si++;
}
console.log(`Total sentinels: ${sentinels.length}`);

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Parse FF-marked records in the pre-entity area
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== FF-MARKED RECORDS (entities in pre-entity area) ===\n');

const ffEntities = [];
for (let off = 0; off < ps.length - 11; off++) {
    if (ps[off + 2] !== 0xFF) continue;
    
    const type = ps.readUInt16BE(off);
    const id = ps.readUInt16BE(off + 3);
    const zeroes = ps.readUInt16BE(off + 5);
    const flags = ps.readUInt16BE(off + 7);
    const one = ps.readUInt16BE(off + 9);
    
    if (zeroes !== 0 || one !== 1) continue;
    if (type < 1 || type > 200 || id < 1 || id > 10000) continue;
    
    ffEntities.push({ type, id, flags, offset: off, format: 'ff' });
}

console.log(`Found ${ffEntities.length} ff-marked records:`);
for (const e of ffEntities) {
    // Read data after header (offset + 11)
    const dataStart = e.offset + 11;
    const refs = [];
    for (let j = 0; j < 8; j++) {
        if (dataStart + j * 2 + 2 <= ps.length) {
            refs.push(ps.readUInt16BE(dataStart + j * 2));
        }
    }
    
    // Check for float64 values
    const floats = [];
    for (let j = 0; j < 4; j++) {
        const foff = dataStart + j * 8;
        if (foff + 8 <= ps.length) {
            const f = ps.readDoubleBE(foff);
            if (isFinite(f) && Math.abs(f) < 1e12 && Math.abs(f) > 1e-20) {
                floats.push({ offset: foff - e.offset, value: f });
            }
        }
    }
    
    console.log(`  type=${e.type} id=${e.id} flags=0x${e.flags.toString(16)} @0x${e.offset.toString(16)}`);
    console.log(`    First 8 int16 refs: [${refs.join(', ')}]`);
    if (floats.length > 0) {
        for (const f of floats) {
            console.log(`    Float64 at +${f.offset}: ${f.value.toFixed(8)}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Map the block structure in the sentinel zone
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== SENTINEL ZONE BLOCK STRUCTURE ===\n');

// For each pair of consecutive sentinels, describe what's between them
const blockTypes = new Map();

for (let i = 0; i < sentinels.length; i++) {
    const sentOff = sentinels[i];
    const nextSentOff = (i + 1 < sentinels.length) ? sentinels[i + 1] : ps.length;
    const blockSize = nextSentOff - sentOff;
    
    // Check what's at sentinel-18 (type-18 entity) and sentinel-10 (type-16 entity)
    let beforeType = null;
    
    // Check for type-18 at sentinel-18
    const t18off = sentOff - 18;
    if (t18off >= 0) {
        const t = ps.readUInt16BE(t18off);
        const o = ps.readUInt16BE(t18off + 8);
        if (t === 18 && o === 1) beforeType = 18;
    }
    
    // Check for type-16 at sentinel-10
    if (!beforeType) {
        const t16off = sentOff - 10;
        if (t16off >= 0) {
            const t = ps.readUInt16BE(t16off);
            const o = ps.readUInt16BE(t16off + 8);
            if (t === 16 && o === 1) beforeType = 16;
        }
    }
    
    // Check for type-30 at sentinel-10
    if (!beforeType) {
        const t30off = sentOff - 10;
        if (t30off >= 0) {
            const t = ps.readUInt16BE(t30off);
            const o = ps.readUInt16BE(t30off + 8);
            if (t === 30 && o === 1) beforeType = 30;
        }
    }
    
    const key = `before=${beforeType ?? '?'} gap=${blockSize}`;
    blockTypes.set(key, (blockTypes.get(key) || 0) + 1);
}

console.log('Block inter-sentinel patterns:');
for (const [key, count] of [...blockTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. For type-16 sentinels, parse the FULL record after sentinel data
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-16 ENTITY FULL RECORD ANALYSIS ===\n');

// Type-16 format: [00 10] [id:2] [00 00] [flags:2] [00 01] [sentinel:8] [refs...]
// The sentinel is the FIRST field data. After sentinel: entity refs (int16 BE)

const type16entities = [];
for (const sentOff of sentinels) {
    const t16off = sentOff - 10;
    if (t16off < 0) continue;
    
    const type = ps.readUInt16BE(t16off);
    const id = ps.readUInt16BE(t16off + 2);
    const zeroes = ps.readUInt16BE(t16off + 4);
    const flags = ps.readUInt16BE(t16off + 6);
    const one = ps.readUInt16BE(t16off + 8);
    
    if (type !== 16 || zeroes !== 0 || one !== 1 || id < 1 || id > 10000) continue;
    
    // Read data after sentinel (sentOff + 8 = data start)
    const dataStart = sentOff + 8;
    const refs = [];
    for (let j = 0; j < 6; j++) {
        if (dataStart + j * 2 + 2 <= ps.length) {
            refs.push(ps.readUInt16BE(dataStart + j * 2));
        }
    }
    
    type16entities.push({ type: 16, id, flags, refs, offset: t16off });
}

console.log(`Type-16 entities found: ${type16entities.length}`);

// Show first 10
for (const e of type16entities.slice(0, 10)) {
    console.log(`  id=${e.id} flags=0x${e.flags.toString(16)} refs=[${e.refs.join(', ')}]`);
}

// Analyze ref patterns: what entity types do type-16 refs point to?
// Build an id→type map from all known entities
const idToType = new Map();
for (const e of type16entities) idToType.set(e.id, 16);
for (const e of ffEntities) idToType.set(e.id, e.type);

// Add sentinel-zone type-18 and type-29 entities
for (const sentOff of sentinels) {
    const off = sentOff - 18;
    if (off < 0) continue;
    const t = ps.readUInt16BE(off);
    const id = ps.readUInt16BE(off + 2);
    const o = ps.readUInt16BE(off + 8);
    if (t === 18 && o === 1 && id > 0 && id < 10000) {
        idToType.set(id, 18);
    }
    const gapStart = sentOff + 8;
    if (gapStart + 6 <= ps.length) {
        const nt = ps.readUInt16BE(gapStart + 2);
        const gid = ps.readUInt16BE(gapStart + 4);
        if (nt === 29 && gid > 0 && gid < 10000) {
            idToType.set(gid, 29);
        }
    }
}

// Now check type-16 ref types
console.log('\nType-16 entity ref patterns (ref types):');
const refPatterns = new Map();
for (const e of type16entities) {
    const pattern = e.refs.slice(0, 6).map(r => {
        const t = idToType.get(r);
        return t ? `t${t}` : (r === 1 || r === 0) ? `${r}` : '?';
    }).join(',');
    refPatterns.set(pattern, (refPatterns.get(pattern) || 0) + 1);
}
for (const [pattern, count] of [...refPatterns.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  [${pattern}]: ${count}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Detailed block walk: what entities are between type-18 sentinels?
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== DETAILED BLOCK WALK (first 20 type-18 sentinels) ===\n');

// Find type-18 sentinels
const type18Sentinels = [];
for (const sentOff of sentinels) {
    const off = sentOff - 18;
    if (off < 0) continue;
    const t = ps.readUInt16BE(off);
    const o = ps.readUInt16BE(off + 8);
    if (t === 18 && o === 1) type18Sentinels.push(sentOff);
}

for (let i = 0; i < Math.min(20, type18Sentinels.length); i++) {
    const sentOff = type18Sentinels[i];
    const entityOff = sentOff - 18;
    const entityId = ps.readUInt16BE(entityOff + 2);
    
    // Find the NEXT type-18 sentinel
    const nextT18Sent = type18Sentinels[i + 1];
    if (!nextT18Sent) break;
    
    const blockStart = sentOff + 8 + 2 + 40; // after sentinel + separator + type-29 entity
    const blockEnd = nextT18Sent - 18;
    const blockSize = blockEnd - blockStart;
    
    // Scan for entity headers within this block
    const blockEntities = [];
    for (let off = blockStart; off < blockEnd - 10; off++) {
        const t = ps.readUInt16BE(off);
        const z = ps.readUInt16BE(off + 4);
        const o = ps.readUInt16BE(off + 8);
        if (z === 0 && o === 1 && t > 0 && t <= 200) {
            const id = ps.readUInt16BE(off + 2);
            if (id > 0 && id < 10000) {
                blockEntities.push({ type: t, id, offset: off - blockStart });
                off += 9; // Skip past this header
            }
        }
    }
    
    console.log(`  Block ${i + 1} (edge ${entityId}, ${blockSize}B between): ${blockEntities.length} entities`);
    for (const e of blockEntities.slice(0, 5)) {
        console.log(`    type=${e.type} id=${e.id} @+${e.offset}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Cross-file comparison: same structure?
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== CROSS-FILE COMPARISON ===\n');

for (const fn of files.slice(0, 4)) {
    const buf = getLargestPS(join(dir, fn));
    if (!buf) continue;
    
    // Count sentinels
    const sents = [];
    let s = 0;
    while ((s = buf.indexOf(SENTINEL, s)) >= 0 && sents.length < 10000) {
        sents.push(s);
        s++;
    }
    
    // Count type-18 vs type-16 sentinels
    let t18 = 0, t16 = 0, other = 0;
    for (const so of sents) {
        const off18 = so - 18;
        const off16 = so - 10;
        if (off18 >= 0 && ps.readUInt16BE !== undefined) {
            const t = buf.readUInt16BE(off18);
            const o = buf.readUInt16BE(off18 + 8);
            if (t === 18 && o === 1) { t18++; continue; }
        }
        if (off16 >= 0) {
            const t = buf.readUInt16BE(off16);
            const o = buf.readUInt16BE(off16 + 8);
            if (t === 16 && o === 1) { t16++; continue; }
        }
        other++;
    }
    
    // Count ff-records
    let ffCount = 0;
    for (let off = 0; off < buf.length - 11; off++) {
        if (buf[off + 2] !== 0xFF) continue;
        const type = buf.readUInt16BE(off);
        const id = buf.readUInt16BE(off + 3);
        const z = buf.readUInt16BE(off + 5);
        const o = buf.readUInt16BE(off + 9);
        if (z === 0 && o === 1 && type > 0 && type <= 200 && id > 0 && id < 10000) ffCount++;
    }
    
    console.log(`${fn}: sents=${sents.length} t18=${t18} t16=${t16} other=${other} ff=${ffCount}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Type-30/31 entities (CURVE/SURFACE) — extract float64 params
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE 30/31 ENTITIES (CURVE/SURFACE DATA) ===\n');

// Find type-30 entities in the sentinel zone
function findTypedEntities(ps, targetType) {
    const results = [];
    for (let off = 0; off < ps.length - 30; off++) {
        const type = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const zeroes = ps.readUInt16BE(off + 4);
        const flags = ps.readUInt16BE(off + 6);
        const one = ps.readUInt16BE(off + 8);
        
        if (type !== targetType || zeroes !== 0 || one !== 1 || id < 1 || id > 10000) continue;
        if (results.find(r => r.id === id)) continue;
        
        // Read refs and float64 data
        const refs = [];
        for (let j = 0; j < 4; j++) refs.push(ps.readUInt16BE(off + 10 + j * 2));
        
        // Look for float64 values after refs
        const floats = [];
        for (let fStart = off + 18; fStart + 8 <= ps.length && fStart < off + 80; fStart += 8) {
            const f = ps.readDoubleBE(fStart);
            if (isFinite(f) && Math.abs(f) < 1e6) floats.push(f);
            else break;
        }
        
        results.push({ type: targetType, id, flags, refs, floats, offset: off });
    }
    return results;
}

const type30 = findTypedEntities(ps, 30);
const type31 = findTypedEntities(ps, 31);

console.log(`Type 30 entities: ${type30.length}`);
for (const e of type30.slice(0, 5)) {
    console.log(`  id=${e.id} refs=[${e.refs.join(',')}] floats(${e.floats.length}): ${e.floats.slice(0, 6).map(f => f.toFixed(4)).join(', ')}`);
}

console.log(`\nType 31 entities: ${type31.length}`);
for (const e of type31.slice(0, 5)) {
    console.log(`  id=${e.id} refs=[${e.refs.join(',')}] floats(${e.floats.length}): ${e.floats.slice(0, 6).map(f => f.toFixed(4)).join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Analyze type 15 entities (LOOP/FACE?)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE 15 ENTITIES ===\n');

const type15 = findTypedEntities(ps, 15);
console.log(`Type 15 entities: ${type15.length}`);
for (const e of type15.slice(0, 10)) {
    // Type 15 refs: examine what types they reference
    const refTypes = e.refs.map(r => {
        const t = idToType.get(r);
        return t ? `${r}(t${t})` : `${r}(?)`;
    }).join(', ');
    console.log(`  id=${e.id} flags=0x${e.flags.toString(16)} refs=[${refTypes}]`);
}
