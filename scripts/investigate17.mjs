/**
 * investigate17.mjs — Find the missing 287 entities
 *
 * From investigate16 we know:
 *   - Type 18 (229 entities): EDGE-like, doubly-linked, refs to type-29 vertices
 *   - Type 29 (227 entities): POINT-like, 3 coords, linked list
 *   - 287 entities MISSING from parsed set (IDs 1-51 + refs from type-18 ref1)
 *
 * These missing entities must be encoded differently. Strategy:
 *   1. Scan the pre-entity area (before first sentinel) for entity headers
 *   2. Scan the post-entity area (after last sentinel) for entity records
 *   3. Try to identify entity header patterns: [type:int16] [id:int16] [00 00] [flags:int16] [00 01]
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

// Find first and last sentinel positions
const sentinels = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 5000) {
    sentinels.push(si);
    si++;
}
const firstSentinel = sentinels[0];
const lastSentinel = sentinels[sentinels.length - 1];

// The first type-18 entity starts 18 bytes before the first sentinel
const firstEntityOff = firstSentinel - 18;

console.log(`First sentinel at: 0x${firstSentinel.toString(16)}`);
console.log(`First entity at: 0x${firstEntityOff.toString(16)}`);
console.log(`Last sentinel at: 0x${lastSentinel.toString(16)}`);
console.log(`Total sentinels: ${sentinels.length}`);
console.log(`Sentinel-record zone: 0x${firstEntityOff.toString(16)} - 0x${(lastSentinel + 50).toString(16)}`);
console.log(`Pre-entity area: 0 to 0x${firstEntityOff.toString(16)} = ${firstEntityOff} bytes`);
console.log(`Post-entity area: 0x${(lastSentinel + 50).toString(16)} to ${ps.length} = ${ps.length - lastSentinel - 50} bytes`);

// ═══════════════════════════════════════════════════════════════════════════════
// Hex dump the pre-entity area
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== PRE-ENTITY AREA (before first sentinel) ===\n');

// Find where the schema/header ends (look for ASCII content)
const headerText = ps.subarray(0, Math.min(600, firstEntityOff)).toString('ascii');
const schEnd = headerText.lastIndexOf('Z');
console.log(`Schema appears to end at ~0x${schEnd > 0 ? schEnd.toString(16) : '??'}`);

// Look at what starts right after schema
const dataStart = schEnd > 0 ? schEnd + 1 : 0;
console.log(`Data area starts at ~0x${dataStart.toString(16)}`);
console.log(`Data area before entities: ${firstEntityOff - dataStart} bytes`);

// Hex dump the data area before entities (looking for entity headers)
function hexDump(buf, start, len) {
    const lines = [];
    for (let i = 0; i < len; i += 16) {
        const off = start + i;
        const bytes = [];
        for (let j = 0; j < 16 && i + j < len; j++) {
            bytes.push(buf[off + j].toString(16).padStart(2, '0'));
        }
        lines.push(`  ${off.toString(16).padStart(6, '0')}: ${bytes.join(' ')}`);
    }
    return lines.join('\n');
}

// Show the region between schema end and first entity  
const preEntityLen = firstEntityOff - dataStart;
if (preEntityLen > 0 && preEntityLen < 2000) {
    console.log(`\nHex dump of data before first entity (${preEntityLen} bytes):`);
    console.log(hexDump(ps, dataStart, preEntityLen));
} else {
    console.log(`\nHex dump of first 512 bytes of data area:`);
    console.log(hexDump(ps, dataStart, Math.min(512, preEntityLen)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scan for entity header pattern: [type:int16] [id:int16] [00 00] [??:int16] [00 01]
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCANNING FOR ENTITY HEADERS (pattern: XX XX  YY YY  00 00  ZZ ZZ  00 01) ===\n');

// Search the entire buffer for the pattern
const entityHeaders = [];
for (let off = dataStart; off < ps.length - 10; off++) {
    const w3 = ps.readUInt16BE(off + 4);   // should be 0x0000
    const w5 = ps.readUInt16BE(off + 8);   // should be 0x0001
    
    if (w3 === 0 && w5 === 1) {
        const type = ps.readUInt16BE(off);
        const id = ps.readUInt16BE(off + 2);
        const flags = ps.readUInt16BE(off + 6);
        
        // Valid entity: type < 100, id > 0, id < 10000
        if (type > 0 && type < 200 && id > 0 && id < 5000) {
            entityHeaders.push({ type, id, flags, offset: off });
        }
    }
}

console.log(`Found ${entityHeaders.length} potential entity headers`);

// Group by type
const headerByType = new Map();
for (const h of entityHeaders) {
    const list = headerByType.get(h.type) || [];
    list.push(h);
    headerByType.set(h.type, list);
}

for (const [type, headers] of [...headerByType.entries()].sort((a, b) => a[0] - b[0])) {
    const ids = headers.map(h => h.id).sort((a, b) => a - b);
    console.log(`  Type ${type}: ${headers.length} entities, IDs: ${ids.slice(0, 30).join(', ')}${ids.length > 30 ? '...' : ''}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// For each entity type, examine the record format
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== ENTITY FORMAT ANALYSIS ===\n');

for (const [type, headers] of [...headerByType.entries()].sort((a, b) => a[0] - b[0])) {
    if (type === 18 || type === 29) continue; // already known
    if (headers.length < 2) continue;
    
    console.log(`--- Type ${type} (${headers.length} entities) ---`);
    
    // Find the spacing between consecutive entities of this type
    const offsets = headers.map(h => h.offset).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < offsets.length; i++) {
        gaps.push(offsets[i] - offsets[i - 1]);
    }
    
    // Show first 3 entities with raw bytes
    for (const h of headers.slice(0, 3)) {
        const rawLen = Math.min(60, ps.length - h.offset);
        const bytes = [];
        for (let j = 0; j < rawLen; j++) {
            bytes.push(ps[h.offset + j].toString(16).padStart(2, '0'));
        }
        console.log(`  id=${h.id} flags=0x${h.flags.toString(16)} @0x${h.offset.toString(16)}`);
        console.log(`    ${bytes.slice(0, 20).join(' ')}`);
        console.log(`    ${bytes.slice(20, 40).join(' ')}`);
        if (rawLen > 40) console.log(`    ${bytes.slice(40, 60).join(' ')}`);
        
        // Try to decode fields after the header (offset+10)
        const fieldStart = h.offset + 10;
        if (fieldStart + 20 < ps.length) {
            // Check for int16 BE entity references
            const refs = [];
            for (let j = 0; j < 10; j++) {
                const ref = ps.readUInt16BE(fieldStart + j * 2);
                if (ref > 0 && ref < 1000) refs.push(ref);
                else refs.push(`(${ref})`);
            }
            console.log(`    Refs: ${refs.join(', ')}`);
        }
    }
    console.log();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Specifically trace the BODY (likely entity 1)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TRACING ENTITY 1 (BODY?) ===\n');

const body = entityHeaders.find(h => h.id === 1);
if (body) {
    console.log(`Entity 1: type=${body.type} flags=0x${body.flags.toString(16)} @0x${body.offset.toString(16)}`);
    // Hex dump 80 bytes
    console.log(hexDump(ps, body.offset, Math.min(80, ps.length - body.offset)));
    
    // Decode fields
    const off = body.offset + 10;
    const refs = [];
    for (let i = 0; i < 20; i++) {
        refs.push(ps.readUInt16BE(off + i * 2));
    }
    console.log(`\nFields: ${refs.join(', ')}`);
}

// Look for entity with smallest IDs
console.log('\n=== FIRST 15 ENTITIES BY ID ===\n');
entityHeaders.sort((a, b) => a.id - b.id);
for (const h of entityHeaders.slice(0, 15)) {
    console.log(`  id=${h.id} type=${h.type} flags=0x${h.flags.toString(16)} @0x${h.offset.toString(16)}`);
    const off = h.offset + 10;
    const refs = [];
    for (let i = 0; i < 8; i++) {
        if (off + i * 2 + 2 <= ps.length) {
            refs.push(ps.readUInt16BE(off + i * 2));
        }
    }
    console.log(`    Fields after header: ${refs.join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Post-entity area
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== POST-ENTITY AREA ===\n');

const postStart = lastSentinel + 50;
const postLen = ps.length - postStart;
console.log(`Post-entity area: ${postLen} bytes (0x${postStart.toString(16)} - 0x${ps.length.toString(16)})`);

if (postLen > 0 && postLen < 2000) {
    console.log(hexDump(ps, postStart, postLen));
}

// Check for entity headers in post area
const postEntities = entityHeaders.filter(h => h.offset >= postStart);
console.log(`\nEntity headers in post area: ${postEntities.length}`);
for (const h of postEntities.slice(0, 10)) {
    console.log(`  id=${h.id} type=${h.type} @0x${h.offset.toString(16)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Map ALL entity types to fill in the topology
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== COMPLETE ENTITY TYPE MAP ===\n');

// Build complete entity map
const allEntities = new Map();
for (const h of entityHeaders) {
    if (!allEntities.has(h.id) || h.offset < allEntities.get(h.id).offset) {
        allEntities.set(h.id, h);
    }
}

// For each known type-18 entity, check if ref1 is now resolved
let ref1Resolved = 0;
for (const h of entityHeaders.filter(h => h.type === 18)) {
    const ref1Id = ps.readUInt16BE(h.offset + 10);
    if (allEntities.has(ref1Id)) ref1Resolved++;
}
console.log(`Type-18 ref1 resolved: ${ref1Resolved}/${entityHeaders.filter(h => h.type === 18).length}`);

// Show entity type distribution around entity IDs 1-60 (the topology header)
console.log('\nEntity types for IDs 1-70:');
for (let id = 1; id <= 70; id++) {
    const h = allEntities.get(id);
    if (h) {
        console.log(`  id=${id}: type=${h.type}`);
    } else {
        console.log(`  id=${id}: NOT FOUND`);
    }
}
