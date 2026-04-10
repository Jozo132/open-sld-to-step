/**
 * investigate15.mjs — Identify entity record types and parse topology chains
 *
 * Key insights from investigate13-14:
 *  - Records within =p chunks have format: [type:int16] [id:int16] [data...]
 *  - The c2 bc 92 8f 99 6e pattern (~-3.14e13) is a sentinel/null reference
 *  - Type 18 and type 29 are the most common entity types
 *  - The first =p chunk (0x638) is a header/class-def area
 *  - Entity data starts from the second =p chunk (0x803)
 *
 * Goal: Build a map of entity types ↔ topology classes and parse chains.
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
        const cs = buf.readUInt32LE(idx + 14);
        const ds = buf.readUInt32LE(idx + 18);
        const nl = buf.readUInt32LE(idx + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50_000_000) {
            const po = idx + 26 + nl;
            const pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (isParasolid(nested) && (!best || nested.length > best.length))
                                best = nested;
                        } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length))
                        best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));

// ═══════════════════════════════════════════════════════════════════════════════
// PART A: Scan ALL entity-like structures across the data area
// Look for [00 XX] [00 YY] patterns where XX is a small type ID and YY is
// incrementing entity IDs
// ═══════════════════════════════════════════════════════════════════════════════

const fname = files.find(f => f.startsWith('nist_ctc_01'));
const ps = getLargestPS(join(dir, fname));
console.log(`File: ${fname}, buffer: ${ps.length} bytes\n`);

// Find the entity data area (after the first big block)
// Skip past the class definition area — find the second =p marker
const allMarkers = [];
for (let i = 0; i < ps.length - 1; i++) {
    if (ps[i] === 0x3d && (ps[i+1] === 0x70 || ps[i+1] === 0x71))
        allMarkers.push(i);
}
console.log(`Total =p/=q markers: ${allMarkers.length}`);
console.log(`First marker at 0x${allMarkers[0].toString(16)}, second at 0x${allMarkers[1].toString(16)}\n`);

// ── Parse entities starting from 0x700 (after class defs) ──
// Key insight: entity records alternate between types 18 (0x12) and 29 (0x1d)
// Let's track all positions where we find [00 12] or [00 1d] and verify them

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);

// Method: scan for the sentinel pattern and analyze what precedes it
// Each sentinel appears at a fixed offset within a record
console.log('=== SENTINEL-ALIGNED ENTITY PARSING ===\n');

const sentinelPositions = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinelPositions.length < 2000) {
    sentinelPositions.push(si);
    si++;
}
console.log(`Sentinel positions: ${sentinelPositions.length}`);

// For each sentinel, look backwards to find the entity header
// Theory: entities have format [00 XX] [00 YY] [00 00] [HH HH] [00 01] [refs..] [sentinel]
// Let's count backwards from sentinel to find how far the entity header is

// First, let's look at a few sentinels and what's before them
console.log('\nSentinels in data area (after 0x700):');
const dataSentinels = sentinelPositions.filter(p => p > 0x700);
console.log(`Count: ${dataSentinels.length}\n`);

// Check what's at fixed offsets BEFORE each sentinel
// For the marker-based records we saw:
//   at +3 (from record start): type int16
//   at +5: entity ID int16
//   at +7: 00 00
//   at +9: flags int16
//   at +11: 00 01
//   at +13: ref1 int16
//   at +15: ref2 int16
//   at +17: ref3 int16
//   at +19: ref4 int16
//   at +21: SENTINEL (8 bytes)
// So sentinel is at offset +21 from *entity start* (not from marker start)
// Entity header is 18 bytes before sentinel

console.log('Entity headers (18 bytes before sentinel):');
const entities = [];
for (let si = 0; si < Math.min(dataSentinels.length, 500); si++) {
    const sentOff = dataSentinels[si];
    const entOff = sentOff - 18; // entity header start
    if (entOff < 0) continue;
    
    const typeId = ps.readUInt16BE(entOff);
    const entityId = ps.readUInt16BE(entOff + 2);
    const zero1 = ps.readUInt16BE(entOff + 4);
    const flags = ps.readUInt16BE(entOff + 6);
    const one = ps.readUInt16BE(entOff + 8);
    const ref1 = ps.readUInt16BE(entOff + 10);
    const ref2 = ps.readUInt16BE(entOff + 12);
    const ref3 = ps.readUInt16BE(entOff + 14);
    const ref4 = ps.readUInt16BE(entOff + 16);
    
    // Check for plausibility: type should be small, entityId should be > 0, one should be 1
    if (typeId > 0 && typeId < 100 && entityId > 0 && entityId < 10000 && one === 1) {
        entities.push({
            offset: entOff,
            sentinelOff: sentOff,
            typeId,
            entityId,
            flags,
            refs: [ref1, ref2, ref3, ref4],
        });
    }
}

console.log(`Valid entities found: ${entities.length}\n`);

// Count entity types
const typeCounts = new Map();
for (const e of entities) {
    typeCounts.set(e.typeId, (typeCounts.get(e.typeId) || 0) + 1);
}
console.log('Entity type distribution:');
for (const [type, count] of [...typeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  type ${type}: ${count} entities`);
}

// Show first 30 entities
console.log('\nFirst 30 entities:');
for (const e of entities.slice(0, 30)) {
    console.log(`  @0x${e.offset.toString(16)}: type=${e.typeId} id=${e.entityId} flags=0x${e.flags.toString(16)} refs=[${e.refs.join(',')}]`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART B: Analyze what comes AFTER the sentinel (the non-sentinel part)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== POST-SENTINEL DATA ===\n');

// After sentinel (8 bytes), what comes next?
// From the raw data we saw: [sentinel] [00 00 00 03] [00 1d] [next entity]
// The "00 00 00 03" could be: padding + count = 3?
// Then "00 1d" = 29, which is another entity type

// Between sentinel-aligned entities, check the gap
for (let i = 0; i < Math.min(20, entities.length - 1); i++) {
    const cur = entities[i];
    const next = entities[i + 1];
    const gap = next.offset - (cur.sentinelOff + 8);
    const gapData = ps.subarray(cur.sentinelOff + 8, next.offset);
    const gapHex = [...gapData].map(b => b.toString(16).padStart(2, '0')).join(' ');
    
    console.log(`  Entity ${cur.entityId} (type=${cur.typeId}) → Entity ${next.entityId} (type=${next.typeId}): gap=${gap} bytes`);
    if (gap > 0 && gap < 100) {
        console.log(`    gap data: ${gapHex}`);
        
        // Try to parse the gap as additional entity fields
        // If gap starts with "00 00 00 03", that might be [padding] [count=3]
        // or [int32=3]
        if (gap >= 4) {
            const g32 = gapData.readUInt32BE(0);
            const g16a = gapData.readUInt16BE(0);
            const g16b = gapData.readUInt16BE(2);
            console.log(`    as int32BE: ${g32}, as int16×2: ${g16a}, ${g16b}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART C: Check if type 29 entities contain coordinate data
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE 29 ENTITIES (LOOKING FOR COORDINATES) ===\n');

// From the raw data, type 29 records seem to have float64 data after refs
// Let's find all type-29 entities and check what's between their refs and the next entity

const type29 = entities.filter(e => e.typeId === 29);
const type18 = entities.filter(e => e.typeId === 18);
console.log(`Type 29 entities: ${type29.length}`);
console.log(`Type 18 entities: ${type18.length}`);

// For each type 29 entity, look at the data between it and the next sentinel
for (let i = 0; i < Math.min(15, type29.length); i++) {
    const e = type29[i];
    // Data starts after the entity header (18 bytes) + sentinel (8 bytes)
    // But the float data might actually be between the header and sentinel
    // OR in the gap after sentinel
    
    // Re-examine: look at ALL data from entity offset forward
    const dataStart = e.offset;
    const nextSentIdx = dataSentinels.findIndex(s => s > e.sentinelOff);
    const nextSent = nextSentIdx >= 0 ? dataSentinels[nextSentIdx] : Math.min(e.offset + 200, ps.length);
    const totalLen = nextSent - dataStart;
    
    // Look for float64 BE values in the entire entity + gap
    const floats = [];
    for (let j = dataStart + 18 + 8; j + 8 <= nextSent && j < dataStart + 100; j++) {
        const v = ps.readDoubleBE(j);
        if (isFinite(v) && v !== 0 && Math.abs(v) > 0.001 && Math.abs(v) < 1e4) {
            floats.push({ relOff: j - dataStart, abs: j, value: v });
        }
    }
    
    // Also look BEFORE sentinel (in the non-ref area)
    // The header is 18 bytes, but refs might not use all of them
    // Actually, refs are at +10..+17 (8 bytes, 4 refs). But maybe type 29 has
    // a different ref layout
    
    console.log(`  type29 id=${e.entityId} @0x${e.offset.toString(16)} refs=[${e.refs.join(',')}] span=${totalLen}b`);
    if (floats.length > 0) {
        console.log(`    floats after sentinel: ${floats.map(f => `+${f.relOff}=${f.value.toFixed(6)}`).join(', ')}`);
    }
    
    // Show raw bytes from header to header+60
    const raw = ps.subarray(dataStart, Math.min(dataStart + 60, ps.length));
    console.log(`    raw: ${[...raw].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART D: Find coordinate-bearing records
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== FINDING COORDINATE-BEARING RECORDS ===\n');

// Known coordinates from investigation: 0.050000, -0.707107, 0.707107, 1.000000
// These appeared in the first big record. Let's find ALL float64 BE values
// that match known geometric values and trace them to entities.

const COORDS = [0.05, -0.05, 0.707107, -0.707107, 1.0, -1.0, 0.5, -0.5, 0.028868, -0.028868];
const coordPositions = [];

for (let i = 0x700; i + 8 <= ps.length; i++) {
    const v = ps.readDoubleBE(i);
    if (!isFinite(v)) continue;
    for (const c of COORDS) {
        if (Math.abs(v - c) < 0.0001) {
            coordPositions.push({ offset: i, value: v, expected: c });
            break;
        }
    }
}

console.log(`Found ${coordPositions.length} positions with known coordinate values`);

// For each, find which entity (if any) it belongs to
for (const cp of coordPositions.slice(0, 30)) {
    // Find the nearest entity before this position
    const nearestEnt = entities.filter(e => e.offset <= cp.offset).pop();
    const relOff = nearestEnt ? cp.offset - nearestEnt.offset : -1;
    console.log(`  @0x${cp.offset.toString(16)}: ${cp.value.toFixed(6)} (expected ${cp.expected}) → entity ${nearestEnt?.entityId} type=${nearestEnt?.typeId} at +${relOff}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART E: Compare entity types across multiple NIST files
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== ENTITY TYPE COMPARISON ACROSS FILES ===\n');

for (const f of files.slice(0, 4)) {
    const buf = getLargestPS(join(dir, f));
    if (!buf) continue;
    
    const sents = [];
    let si = 0;
    const sent = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);
    while ((si = buf.indexOf(sent, si)) >= 0 && sents.length < 2000) {
        sents.push(si);
        si++;
    }
    
    const ents = [];
    for (const s of sents.filter(s => s > 0x700)) {
        const off = s - 18;
        if (off < 0) continue;
        const typeId = buf.readUInt16BE(off);
        const entityId = buf.readUInt16BE(off + 2);
        const one = buf.readUInt16BE(off + 8);
        if (typeId > 0 && typeId < 100 && entityId > 0 && entityId < 10000 && one === 1) {
            ents.push({ typeId, entityId });
        }
    }
    
    const tc = new Map();
    for (const e of ents) tc.set(e.typeId, (tc.get(e.typeId) || 0) + 1);
    
    const maxId = ents.length > 0 ? Math.max(...ents.map(e => e.entityId)) : 0;
    console.log(`${f}: ${sents.length} sentinels, ${ents.length} valid entities, maxId=${maxId}`);
    for (const [type, count] of [...tc.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`    type ${type}: ${count}`);
    }
}
