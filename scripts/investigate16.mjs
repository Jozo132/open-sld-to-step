/**
 * investigate16.mjs — Full entity parsing: both type-18 and type-29 records
 *
 * Key discovery from investigate15:
 *  - Type 18 entities: [header 18B] + [sentinel 8B] = 26 bytes, 4 refs, no coords
 *  - Type 29 entities: embedded in the gap between type-18 records, 3 refs + 3 float64
 *  - Together they form topology chains (EDGE→VERTEX with coordinates)
 *
 * Format:
 *   TYPE 18: [00 12] [ID:2] [00 00] [flags:2] [00 01] [ref1:2] [ref2:2] [ref3:2] [ref4:2] [sentinel:8]
 *   GAP:     [00 03] ← separator (2 bytes)
 *   TYPE 29: [00 1d] [ID:2] [00 00] [flags:2] [00 01] [ref1:2] [ref2:2] [ref3:2] [x:8] [y:8] [z:8]
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

function parseEntities(ps) {
    // Find all sentinel positions
    const sentinels = [];
    let si = 0;
    while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 5000) {
        sentinels.push(si);
        si++;
    }
    
    const entities = new Map(); // id → entity
    
    // Parse type-18 entities (sentinel-aligned)
    for (const sentOff of sentinels) {
        const off = sentOff - 18;
        if (off < 0) continue;
        
        const typeId = ps.readUInt16BE(off);
        const entityId = ps.readUInt16BE(off + 2);
        const flags = ps.readUInt16BE(off + 6);
        const one = ps.readUInt16BE(off + 8);
        
        if (typeId !== 18 || one !== 1 || entityId === 0 || entityId > 10000) continue;
        
        const refs = [
            ps.readUInt16BE(off + 10),
            ps.readUInt16BE(off + 12),
            ps.readUInt16BE(off + 14),
            ps.readUInt16BE(off + 16),
        ];
        
        entities.set(entityId, { type: 18, id: entityId, flags, refs, coords: null, offset: off });
        
        // Check for type-29 entity in the gap after the sentinel
        const gapStart = sentOff + 8;
        if (gapStart + 42 <= ps.length) {
            const separator = ps.readUInt16BE(gapStart);
            const nextType = ps.readUInt16BE(gapStart + 2);
            
            if (nextType === 29 || nextType === 0x1d) { // type 29
                const gapId = ps.readUInt16BE(gapStart + 4);
                const gapFlags = ps.readUInt16BE(gapStart + 8);
                const gapOne = ps.readUInt16BE(gapStart + 10);
                
                if (gapOne === 1 && gapId > 0 && gapId < 10000) {
                    const gapRefs = [
                        ps.readUInt16BE(gapStart + 12),
                        ps.readUInt16BE(gapStart + 14),
                        ps.readUInt16BE(gapStart + 16),
                    ];
                    
                    // Read coordinates (3 × float64 BE)
                    const x = ps.readDoubleBE(gapStart + 18);
                    const y = ps.readDoubleBE(gapStart + 26);
                    const z = ps.readDoubleBE(gapStart + 34);
                    
                    const coords = (isFinite(x) && isFinite(y) && isFinite(z)) 
                        ? { x, y, z } 
                        : null;
                    
                    entities.set(gapId, { 
                        type: 29, id: gapId, flags: gapFlags, 
                        refs: gapRefs, coords, offset: gapStart + 2 
                    });
                }
            }
        }
    }
    
    return entities;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parse the marker-based file
// ═══════════════════════════════════════════════════════════════════════════════

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const fname = files.find(f => f.startsWith('nist_ctc_01'));
const ps = getLargestPS(join(dir, fname));
console.log(`File: ${fname}, buffer: ${ps.length} bytes\n`);

const entities = parseEntities(ps);
console.log(`Total entities parsed: ${entities.size}`);

const byType = new Map();
for (const e of entities.values()) {
    byType.set(e.type, (byType.get(e.type) || []).concat([e]));
}
for (const [type, ents] of byType) {
    const withCoords = ents.filter(e => e.coords !== null);
    console.log(`  Type ${type}: ${ents.length} entities (${withCoords.length} with coordinates)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Build reference graph
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== REFERENCE GRAPH ===\n');

// For type-29 entities with coordinates, trace their references
const type29 = [...entities.values()].filter(e => e.type === 29 && e.coords);
console.log(`Type 29 with coords: ${type29.length}`);

// Show first 20 type-29 entities with their coords and ref chain
console.log('\nFirst 25 type-29 entities:');
for (const e of type29.slice(0, 25)) {
    const refInfo = e.refs.map(r => {
        const target = entities.get(r);
        return target ? `${r}(t${target.type})` : `${r}(?)`;
    }).join(', ');
    
    const c = e.coords;
    console.log(`  id=${e.id} refs=[${refInfo}] coords=(${c.x.toFixed(6)}, ${c.y.toFixed(6)}, ${c.z.toFixed(6)})`);
}

// For type-18 entities, trace what they reference
console.log('\nFirst 25 type-18 entities (with ref types):');
const type18 = [...entities.values()].filter(e => e.type === 18).sort((a, b) => a.id - b.id);
for (const e of type18.slice(0, 25)) {
    const refInfo = e.refs.map(r => {
        const target = entities.get(r);
        return target ? `${r}(t${target.type}${target.coords ? '*' : ''})` : `${r}(?)`;
    }).join(', ');
    console.log(`  id=${e.id} flags=0x${e.flags.toString(16)} refs=[${refInfo}]`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Topology classification
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TOPOLOGY CLASSIFICATION ATTEMPT ===\n');

// Type-29 with coordinates → POINT / VERTEX (contains position data)
// Type-18 with 4 refs → could be EDGE, FACE, LOOP, etc.

// Classify type-18 by ref pattern:
// If all 4 refs are type-18 → probably BODY or SHELL (refs to faces/edges)
// If 2 refs are type-29 + 2 are type-18 → probably EDGE (start_vertex, end_vertex + curve, ?)
// etc.

for (const e of type18) {
    const refTypes = e.refs.map(r => entities.get(r)?.type ?? '?');
    const refPattern = refTypes.join(',');
    e.refPattern = refPattern;
}

const patternCounts = new Map();
for (const e of type18) {
    patternCounts.set(e.refPattern, (patternCounts.get(e.refPattern) || 0) + 1);
}
console.log('Type-18 reference patterns (refType1,refType2,refType3,refType4):');
for (const [pattern, count] of [...patternCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  [${pattern}]: ${count} entities`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Check the FIRST record (the big one at 0x638)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== FIRST BIG RECORD (BODY/GLOBAL) ===\n');

// The first record at 0x638 is 459 bytes — way bigger than normal records
// Let's check what entity IDs are referenced that we DON'T find in parsed entities
const allIds = new Set(entities.keys());
const allRefs = new Set();
for (const e of entities.values()) {
    for (const r of e.refs) allRefs.add(r);
}

const unresolvedRefs = [...allRefs].filter(r => !allIds.has(r) && r > 0 && r < 10000);
console.log(`Unresolved entity references: ${unresolvedRefs.length}`);
console.log(`IDs: ${unresolvedRefs.sort((a, b) => a - b).slice(0, 50).join(', ')}`);

// These unresolved entities might be in the first big record or use different formats
// Let's check what entity IDs are missing from the sequential numbering
const consecutiveIds = new Set();
const maxId = Math.max(...[...allIds]);
for (let i = 1; i <= maxId; i++) consecutiveIds.add(i);
const missingIds = [...consecutiveIds].filter(id => !allIds.has(id));
console.log(`\nEntity ID range: 1..${maxId}`);
console.log(`Known entities: ${allIds.size}`);
console.log(`Missing IDs: ${missingIds.length}`);
if (missingIds.length <= 100) {
    console.log(`Missing: ${missingIds.join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Try the same approach on a NO-MARKER file
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n\n' + '═'.repeat(80));
console.log('=== SAME ANALYSIS ON NO-MARKER FILE ===');
console.log('═'.repeat(80));

const fname2 = files.find(f => f.startsWith('nist_ctc_03'));
const ps2 = getLargestPS(join(dir, fname2));
console.log(`\nFile: ${fname2}, buffer: ${ps2.length} bytes\n`);

const entities2 = parseEntities(ps2);
console.log(`Total entities parsed: ${entities2.size}`);

const byType2 = new Map();
for (const e of entities2.values()) {
    byType2.set(e.type, (byType2.get(e.type) || []).concat([e]));
}
for (const [type, ents] of byType2) {
    const withCoords = ents.filter(e => e.coords !== null);
    console.log(`  Type ${type}: ${ents.length} entities (${withCoords.length} with coordinates)`);
}

const type29_2 = [...entities2.values()].filter(e => e.type === 29 && e.coords);
console.log(`\nType 29 with coords: ${type29_2.length}`);

// Show first 15
console.log('\nFirst 15 type-29 entities:');
for (const e of type29_2.slice(0, 15)) {
    const c = e.coords;
    console.log(`  id=${e.id} refs=[${e.refs.join(',')}] coords=(${c.x.toFixed(6)}, ${c.y.toFixed(6)}, ${c.z.toFixed(6)})`);
}

// Classify type-18 ref patterns
const type18_2 = [...entities2.values()].filter(e => e.type === 18);
for (const e of type18_2) {
    const refTypes = e.refs.map(r => entities2.get(r)?.type ?? '?');
    e.refPattern = refTypes.join(',');
}
const pc2 = new Map();
for (const e of type18_2) pc2.set(e.refPattern, (pc2.get(e.refPattern) || 0) + 1);
console.log('\nType-18 reference patterns:');
for (const [pattern, count] of [...pc2.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  [${pattern}]: ${count} entities`);
}

// Compare coordinate counts
const allCoords1 = type29.map(e => e.coords);
const allCoords2 = type29_2.map(e => e.coords);
console.log(`\n=== COORDINATE COMPARISON ===`);
console.log(`File 1 (markers): ${allCoords1.length} coordinates`);
console.log(`File 2 (no markers): ${allCoords2.length} coordinates`);

// Show coordinate ranges
if (allCoords1.length > 0) {
    console.log(`File 1 X: [${Math.min(...allCoords1.map(c => c.x)).toFixed(6)}, ${Math.max(...allCoords1.map(c => c.x)).toFixed(6)}]`);
    console.log(`File 1 Y: [${Math.min(...allCoords1.map(c => c.y)).toFixed(6)}, ${Math.max(...allCoords1.map(c => c.y)).toFixed(6)}]`);
    console.log(`File 1 Z: [${Math.min(...allCoords1.map(c => c.z)).toFixed(6)}, ${Math.max(...allCoords1.map(c => c.z)).toFixed(6)}]`);
}
if (allCoords2.length > 0) {
    console.log(`File 2 X: [${Math.min(...allCoords2.map(c => c.x)).toFixed(6)}, ${Math.max(...allCoords2.map(c => c.x)).toFixed(6)}]`);
    console.log(`File 2 Y: [${Math.min(...allCoords2.map(c => c.y)).toFixed(6)}, ${Math.max(...allCoords2.map(c => c.y)).toFixed(6)}]`);
    console.log(`File 2 Z: [${Math.min(...allCoords2.map(c => c.z)).toFixed(6)}, ${Math.max(...allCoords2.map(c => c.z)).toFixed(6)}]`);
}
