/**
 * investigate18.mjs — Trace topology chains from type-18 doubly-linked lists
 *
 * Type-18 entity refs: [ref1=curve?, ref2=prev_edge, ref3=next_edge, ref4=vertex]
 * Following ref3 (next_edge) should close into LOOPS → FACES
 *
 * Type-29 entity refs: [ref1=next_type18, ref2=next_type29, ref3=prev_type29]
 * These form a parallel linked list of vertices
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
    const sentinels = [];
    let si = 0;
    while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 5000) {
        sentinels.push(si);
        si++;
    }
    
    const entities = new Map();
    
    for (const sentOff of sentinels) {
        const off = sentOff - 18;
        if (off < 0) continue;
        
        const typeId = ps.readUInt16BE(off);
        const entityId = ps.readUInt16BE(off + 2);
        const flags = ps.readUInt16BE(off + 6);
        const one = ps.readUInt16BE(off + 8);
        
        if (typeId !== 18 && typeId !== 16) continue;  // Also try type 16
        if (one !== 1 || entityId === 0 || entityId > 10000) continue;
        
        const refs = [
            ps.readUInt16BE(off + 10),
            ps.readUInt16BE(off + 12),
            ps.readUInt16BE(off + 14),
            ps.readUInt16BE(off + 16),
        ];
        
        entities.set(entityId, { type: typeId, id: entityId, flags, refs, coords: null, offset: off });
        
        const gapStart = sentOff + 8;
        if (gapStart + 42 <= ps.length) {
            const nextType = ps.readUInt16BE(gapStart + 2);
            
            if (nextType === 29) {
                const gapId = ps.readUInt16BE(gapStart + 4);
                const gapFlags = ps.readUInt16BE(gapStart + 8);
                const gapOne = ps.readUInt16BE(gapStart + 10);
                
                if (gapOne === 1 && gapId > 0 && gapId < 10000) {
                    const gapRefs = [
                        ps.readUInt16BE(gapStart + 12),
                        ps.readUInt16BE(gapStart + 14),
                        ps.readUInt16BE(gapStart + 16),
                    ];
                    
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
            
            // Also try: gap entity at different position
            // Type 30 entities: [type:2] [id:2] [00 00] [flags:2] [00 01] [refs...] [float64s...]
            // They appear at various offsets
        }
    }
    
    // Also scan for type 30/31/50/51 entities in the sentinel zone
    // These have the sentinel INSIDE their data (false positive) 
    // so we need a different approach — scan for their headers
    for (let off = 0; off < ps.length - 60; off++) {
        const w3 = ps.readUInt16BE(off + 4);
        const w5 = ps.readUInt16BE(off + 8);
        if (w3 !== 0 || w5 !== 1) continue;
        
        const type = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const flags = ps.readUInt16BE(off + 6);
        
        // Only look for specific types that we know exist: 15, 16, 30, 31
        if (![15, 16, 30, 31, 50, 51].includes(type)) continue;
        if (id < 1 || id > 5000 || entities.has(id)) continue;
        
        // Read refs and check for reasonable entity ID values
        const refs = [];
        let valid = true;
        for (let j = 0; j < 4; j++) {
            const r = ps.readUInt16BE(off + 10 + j * 2);
            refs.push(r);
        }
        
        entities.set(id, { type, id, flags, refs, coords: null, offset: off });
    }
    
    return entities;
}

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const fname = files.find(f => f.startsWith('nist_ctc_01'));
const ps = getLargestPS(join(dir, fname));
console.log(`File: ${fname}, buffer: ${ps.length} bytes\n`);

const entities = parseEntities(ps);
const type18 = [...entities.values()].filter(e => e.type === 18).sort((a, b) => a.id - b.id);
const type29 = [...entities.values()].filter(e => e.type === 29);

console.log(`Total entities: ${entities.size}`);
console.log(`Type 18: ${type18.length}, Type 29: ${type29.length}`);

// ═══════════════════════════════════════════════════════════════════════════════
// Trace LOOPS by following ref3 (next_edge)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TRACING EDGE LOOPS ===\n');

const visited = new Set();
const loops = [];

for (const startEdge of type18) {
    if (visited.has(startEdge.id)) continue;
    
    const loop = [startEdge.id];
    visited.add(startEdge.id);
    
    let current = startEdge;
    let iterations = 0;
    
    while (iterations < 1000) {
        const nextId = current.refs[2]; // ref3 = next_edge
        if (nextId === startEdge.id) {
            // Loop closed!
            break;
        }
        
        const nextEdge = entities.get(nextId);
        if (!nextEdge || nextEdge.type !== 18 || visited.has(nextEdge.id)) {
            // Broken chain or unknown entity
            loop.push(`→${nextId}(?)`);
            break;
        }
        
        loop.push(nextEdge.id);
        visited.add(nextEdge.id);
        current = nextEdge;
        iterations++;
    }
    
    loops.push(loop);
}

console.log(`Found ${loops.length} loops:`);
for (let i = 0; i < loops.length; i++) {
    const loop = loops[i];
    const isClosed = typeof loop[loop.length - 1] === 'number';
    
    // Get vertex coordinates for this loop
    const coords = [];
    for (const edgeId of loop) {
        if (typeof edgeId !== 'number') continue;
        const edge = entities.get(edgeId);
        if (!edge) continue;
        const vertexId = edge.refs[3]; // ref4 = vertex
        const vertex = entities.get(vertexId);
        if (vertex && vertex.coords) {
            coords.push({ id: vertexId, ...vertex.coords });
        }
    }
    
    const status = isClosed ? 'CLOSED' : 'OPEN';
    console.log(`  Loop ${i + 1}: ${loop.length} edges [${status}]  (${coords.length} vertices with coords)`);
    
    // Show vertex coordinates for small loops
    if (loop.length <= 12) {
        for (const c of coords) {
            console.log(`    vertex ${c.id}: (${c.x.toFixed(6)}, ${c.y.toFixed(6)}, ${c.z.toFixed(6)})`);
        }
    } else {
        // Show first 3 and last 3 coords
        for (const c of coords.slice(0, 3)) {
            console.log(`    vertex ${c.id}: (${c.x.toFixed(6)}, ${c.y.toFixed(6)}, ${c.z.toFixed(6)})`);
        }
        if (coords.length > 6) console.log(`    ... ${coords.length - 6} more vertices ...`);
        for (const c of coords.slice(-3)) {
            console.log(`    vertex ${c.id}: (${c.x.toFixed(6)}, ${c.y.toFixed(6)}, ${c.z.toFixed(6)})`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Analyze loop structure
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== LOOP ANALYSIS ===\n');

const closedLoops = loops.filter(l => typeof l[l.length - 1] === 'number');
const openLoops = loops.filter(l => typeof l[l.length - 1] !== 'number');

console.log(`Closed loops: ${closedLoops.length}`);
console.log(`Open/broken chains: ${openLoops.length}`);

// Edge count distribution
const edgeCounts = new Map();
for (const loop of closedLoops) {
    const n = loop.length;
    edgeCounts.set(n, (edgeCounts.get(n) || 0) + 1);
}
console.log('\nEdge count distribution (closed loops):');
for (const [n, count] of [...edgeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${n} edges: ${count} loops`);
}

// Check if loops share vertices (indication of shared edges)
console.log('\n=== VERTEX SHARING ANALYSIS ===\n');

const vertexToLoops = new Map();
for (let i = 0; i < loops.length; i++) {
    for (const edgeId of loops[i]) {
        if (typeof edgeId !== 'number') continue;
        const edge = entities.get(edgeId);
        if (!edge) continue;
        const vertexId = edge.refs[3];
        if (!vertexToLoops.has(vertexId)) vertexToLoops.set(vertexId, []);
        vertexToLoops.get(vertexId).push(i);
    }
}

const sharedVertices = [...vertexToLoops.entries()]
    .filter(([, loops]) => loops.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

console.log(`Vertices shared between loops: ${sharedVertices.length}`);
for (const [vertexId, loopIndices] of sharedVertices.slice(0, 20)) {
    const v = entities.get(vertexId);
    const coords = v?.coords ? `(${v.coords.x.toFixed(4)}, ${v.coords.y.toFixed(4)}, ${v.coords.z.toFixed(4)})` : '?';
    console.log(`  vertex ${vertexId} ${coords}: shared by loops [${[...new Set(loopIndices)].map(i => i + 1).join(', ')}]`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Now scan the 0x5b9-0x769 area more carefully to find entities by `ff` marker
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== FF-MARKER RECORDS IN PRE-ENTITY AREA ===\n');

// Pattern observed: [nn nn] ff [type:2] [00 00] [flags:2] [00 01]
// Where nn nn might be a length/ID prefix

const schemaEnd = 0x58A; // approximate end of last CZ block
const firstEntityOff = type18[0].offset;

for (let off = schemaEnd; off < firstEntityOff; off++) {
    if (ps[off] !== 0xFF) continue;
    
    // Check if this looks like: ff [type:int16] [id:int16?] [flags:int16] [00 01]
    // Or: [id/len:int16] ff [entity_type:int16] [00 00] [flags:int16] [00 01]
    
    // Try pattern: [id:2] ff [00 type:1] [00 00] [flags:2] [00 01]
    if (off >= 2 && off + 9 < ps.length) {
        const before = ps.readUInt16BE(off - 2);
        const afterW1 = ps.readUInt16BE(off + 1);
        const zeroes = ps.readUInt16BE(off + 3);
        const flags = ps.readUInt16BE(off + 5);
        const one = ps.readUInt16BE(off + 7);
        
        if (one === 1 && afterW1 > 0 && afterW1 < 50) {
            console.log(`  @0x${(off-2).toString(16)}: before=0x${before.toString(16)}, ff, type=${afterW1}, field=0x${zeroes.toString(16)}, flags=0x${flags.toString(16)}`);
            
            // Dump 40 bytes from this position
            const bytes = [];
            for (let j = -2; j < 40; j++) {
                if (off + j < ps.length) bytes.push(ps[off + j].toString(16).padStart(2, '0'));
            }
            console.log(`    ${bytes.join(' ')}`);
            
            // Try to read float64 values
            const floatStart = off + 9;
            if (floatStart + 24 <= ps.length) {
                const f1 = ps.readDoubleBE(floatStart);
                const f2 = ps.readDoubleBE(floatStart + 8);
                const f3 = ps.readDoubleBE(floatStart + 16);
                if (isFinite(f1) && Math.abs(f1) < 1e6) {
                    console.log(`    Floats: ${f1.toFixed(6)}, ${f2.toFixed(6)}, ${f3.toFixed(6)}`);
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Also look for the NON-sentinel entity types (16, 30, 31) in sentinel zone
// These contain the sentinel bytes as DATA, not delimiters
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== NON-SENTINEL ENTITY TYPES (16, 30, 31) ===\n');

// For type 16 entities, they have the sentinel in their data
// Let's look at one to understand the format
function findEntityRecords(ps, targetType) {
    const records = [];
    for (let off = 0; off < ps.length - 10; off++) {
        const type = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const zeroes = ps.readUInt16BE(off + 4);
        const flags = ps.readUInt16BE(off + 6);
        const one = ps.readUInt16BE(off + 8);
        
        if (type === targetType && zeroes === 0 && one === 1 && id > 0 && id < 5000) {
            records.push({ type, id, flags, offset: off });
        }
    }
    return records;
}

// Type 16 entities (found in investigate17)
const type16records = findEntityRecords(ps, 16);
// Filter to likely real records: check for reasonable spacing
console.log(`Type 16 raw matches: ${type16records.length}`);

// Look at the first type-16 in the sentinel zone
const sentinelZoneStart = type18[0].offset;
const type16InZone = type16records.filter(r => r.offset >= sentinelZoneStart);
console.log(`Type 16 in sentinel zone: ${type16InZone.length}`);

// Show first 5 with context
for (const r of type16InZone.slice(0, 5)) {
    console.log(`\n  Type 16 id=${r.id} flags=0x${r.flags.toString(16)} @0x${r.offset.toString(16)}`);
    
    // Read refs
    const refs = [];
    for (let j = 0; j < 6; j++) {
        refs.push(ps.readUInt16BE(r.offset + 10 + j * 2));
    }
    console.log(`    First 6 refs: ${refs.join(', ')}`);
    
    // Check if this entity contains the sentinel
    const sentinelOff = ps.indexOf(SENTINEL, r.offset + 10);
    if (sentinelOff >= 0 && sentinelOff < r.offset + 100) {
        console.log(`    Sentinel at +${sentinelOff - r.offset} (0x${sentinelOff.toString(16)})`);
    }
    
    // Try to find the NEXT entity header after this one
    // Look for next [00 XX] [00 YY] [00 00] [ZZ ZZ] [00 01] within 100 bytes
    for (let scan = r.offset + 10; scan < r.offset + 120 && scan < ps.length - 10; scan++) {
        const st = ps.readUInt16BE(scan);
        const sz = ps.readUInt16BE(scan + 4);
        const so = ps.readUInt16BE(scan + 8);
        if (sz === 0 && so === 1 && st > 0 && st <= 51 && st !== 16) {
            const sid = ps.readUInt16BE(scan + 2);
            if (sid > 0 && sid < 5000) {
                console.log(`    Next entity at +${scan - r.offset}: type=${st} id=${sid}`);
                break;
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary: count ALL distinct entity types actually in the sentinel zone
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== SENTINEL ZONE ENTITY TYPE SUMMARY ===\n');

// The sentinel zone contains interleaved records. Each 68-byte block:
// [type-18: 26 bytes] [separator: 2 bytes] [type-29: 40 bytes]
// But SOME sentinels are actually part of type-16 records, not type-18 terminators

// Let's check: for each sentinel, is the entity before it ALWAYS type 18?
let type18Count = 0, otherCount = 0;
const sentinels = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 5000) {
    sentinels.push(si);
    si++;
}

for (const sentOff of sentinels) {
    const off = sentOff - 18;
    if (off < 0) continue;
    const type = ps.readUInt16BE(off);
    const one = ps.readUInt16BE(off + 8);
    if (type === 18 && one === 1) type18Count++;
    else otherCount++;
}
console.log(`Sentinels preceded by type-18: ${type18Count}`);
console.log(`Sentinels preceded by other: ${otherCount}`);

// For the "other" sentinels, what type precedes them?
const otherTypes = new Map();
for (const sentOff of sentinels) {
    const off = sentOff - 18;
    if (off < 0) continue;
    const type = ps.readUInt16BE(off);
    const one = ps.readUInt16BE(off + 8);
    if (type !== 18 || one !== 1) {
        // Check a wider range
        // Maybe the entity is at a different offset relative to sentinel
        for (let delta = -30; delta <= 0; delta += 2) {
            const ts = sentOff + delta;
            if (ts < 0) continue;
            const t = ps.readUInt16BE(ts);
            const o = ps.readUInt16BE(ts + 8);
            if (o === 1 && t > 0 && t <= 51) {
                otherTypes.set(`type=${t} delta=${-18 - delta}`, (otherTypes.get(`type=${t} delta=${-18 - delta}`) || 0) + 1);
            }
        }
    }
}
if (otherTypes.size > 0) {
    console.log('\nNon-type-18 sentinel contexts:');
    for (const [k, v] of otherTypes) console.log(`  ${k}: ${v} times`);
}
