/**
 * investigate30.mjs — Decode multi-entity sentinel blocks
 * 
 * The type-0x11 blocks are huge (100-2000 bytes) and contain MULTIPLE entity
 * records. Need to find the correct sub-record delimiter pattern.
 * 
 * Key insight from investigate28: entity records start with [00 type:1] [id:2]
 * Let's scan each block for ALL occurrences of [00 XX] where XX is a known type.
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);

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
                        try { const n = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 }); if (n.length >= 20 && n[0] === 0x50 && n[1] === 0x53 && (!best || n.length > best.length)) best = n; } catch {}
                    }
                    if (dec.length >= 20 && dec[0] === 0x50 && dec[1] === 0x53 && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

const ps = getLargestPS(join(sldDir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
console.log(`PS buffer: ${ps.length} bytes\n`);

// Find sentinels
const sentPositions = [];
let idx = 0;
while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx++; }
console.log(`Sentinels: ${sentPositions.length}\n`);

// The known entity type codes from investigate28 + STEP cross-reference
const KNOWN_TYPES = new Set([
    0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, // topology: attrib, face, edge, shell, coedge, loop
    0x1d, 0x1e, 0x1f, 0x20, 0x26,        // geometry: point, surface/curve, bspline, ?, ?
    0x2d, 0x2b, 0x2f, 0x32,              // possible: -, +, /, 2
]);

// Strategy: scan the FULL PS buffer (after header area) for ALL [00 XX YY YY]
// patterns where XX is a type byte and YY YY is a plausible entity ID.
// Then verify by checking if the data around them makes sense.

// First, let's look at one big multi-entity block in detail
// Type-0x11 id=54 has 92 bytes of data — let's trace every byte
console.log('=== DETAILED PARSE OF LARGE TYPE-0x11 BLOCK ===\n');

// Find the block containing entity id=54 (type 0x11)
for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + 6;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
    const block = ps.subarray(blockStart, blockEnd);
    
    if (block.length < 8) continue;
    if (block.readUInt32BE(0) !== 3) continue;
    
    const type = block.readUInt16BE(4);
    const id = block.readUInt16BE(6);
    
    if (type === 0x11 && id === 54) {
        console.log(`Block at sentinel[${i}] @0x${blockStart.toString(16)}, len=${block.length}`);
        
        // Full hex dump with annotations
        for (let off = 0; off < block.length; off += 16) {
            const slice = block.subarray(off, Math.min(off + 16, block.length));
            const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
            console.log(`  +${off.toString().padStart(4)}: ${hex.padEnd(48)}  ${ascii}`);
        }
        
        // Now try to find all [00 XX] type markers within the block
        console.log('\n  Sub-record markers found:');
        for (let j = 0; j + 3 < block.length; j++) {
            if (block[j] === 0x00 && block[j + 1] >= 0x0e && block[j + 1] <= 0x32) {
                const subType = block[j + 1];
                const subId = block.readUInt16BE(j + 2);
                // Check: is subId reasonable?
                if (subId > 0 && subId < 5000) {
                    // Check what byte precedes the [00 XX]
                    const prevByte = j > 0 ? block[j - 1] : -1;
                    console.log(`    @+${j}: type=0x${subType.toString(16)} id=${subId} prev=0x${prevByte >= 0 ? prevByte.toString(16).padStart(2, '0') : '--'}`);
                }
            }
        }
        break;
    }
}

// Now let's look at the big type-0x0f (FACE) block — id=1915 had 2063 bytes
console.log('\n=== DETAILED PARSE OF LARGE TYPE-0x0F (FACE) BLOCK ===\n');

for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + 6;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
    const block = ps.subarray(blockStart, blockEnd);
    
    if (block.length < 8) continue;
    
    // Scan for type 0x0f within blocks
    for (let j = 0; j + 3 < block.length; j++) {
        if (block[j] === 0x00 && block[j + 1] === 0x0f) {
            const subId = block.readUInt16BE(j + 2);
            if (subId === 0x077b) { // id=1915
                console.log(`FACE block at sentinel[${i}] @0x${blockStart.toString(16)}, found at +${j}, blockLen=${block.length}`);
                
                // Find all [00 XX] type markers
                console.log('  All entity markers in this block:');
                for (let k = 0; k + 3 < block.length; k++) {
                    if (block[k] === 0x00 && block[k + 1] >= 0x0e && block[k + 1] <= 0x32 && block.length > k + 3) {
                        const st = block[k + 1];
                        const si = block.readUInt16BE(k + 2);
                        if (si > 0 && si < 5000) {
                            const prevByte = k > 0 ? block[k - 1].toString(16).padStart(2, '0') : '--';
                            console.log(`    @+${k}: type=0x${st.toString(16)} id=${si} prev=0x${prevByte}`);
                        }
                    }
                }
                
                // First 200 bytes hex
                console.log('\n  First 200 bytes:');
                for (let off = 0; off < Math.min(200, block.length); off += 16) {
                    const slice = block.subarray(off, Math.min(off + 16, block.length));
                    const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
                    console.log(`    +${off.toString().padStart(4)}: ${hex}`);
                }
                break;
            }
        }
    }
}

// ── Key question: What byte appears immediately before each [00 type] marker? ──
// If it's always the same byte (like 0x2b, 0x2d, 0x01), that's our sub-record separator.
console.log('\n=== BYTE BEFORE ALL [00 TYPE] MARKERS IN ENTITY DATA ===\n');

const prevByteHist = new Map();
const typeAfterPrev = new Map(); // prevByte → Set<types seen after>
let totalMarkers = 0;

for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + 6;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
    const block = ps.subarray(blockStart, blockEnd);
    
    // Skip the first entity header (already parsed)
    for (let j = 8; j + 3 < block.length; j++) {
        if (block[j] === 0x00 && block[j + 1] >= 0x0e && block[j + 1] <= 0x32) {
            const subId = block.readUInt16BE(j + 2);
            if (subId < 1 || subId > 5000) continue;
            
            const prevByte = block[j - 1];
            const key = `0x${prevByte.toString(16).padStart(2, '0')}`;
            prevByteHist.set(key, (prevByteHist.get(key) || 0) + 1);
            
            if (!typeAfterPrev.has(key)) typeAfterPrev.set(key, new Set());
            typeAfterPrev.get(key).add(block[j + 1]);
            totalMarkers++;
        }
    }
}

console.log(`Total [00 type] markers found (after pos 8): ${totalMarkers}`);
for (const [prev, count] of [...prevByteHist.entries()].sort((a, b) => b[1] - a[1])) {
    const types = [...(typeAfterPrev.get(prev) || [])].map(t => `0x${t.toString(16)}`).join(',');
    console.log(`  prev=${prev}: ${count} times → types: ${types}`);
}

// ── Now count ALL entity types we can find by scanning full blocks ──
console.log('\n=== FULL SCAN OF ALL SENTINEL BLOCKS FOR ENTITY RECORDS ===\n');

const allEntities = [];

for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + 6;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
    const block = ps.subarray(blockStart, blockEnd);
    
    if (block.length < 4) continue;
    
    // Method: scan for [2b|2d|01] [00 type] [id:2] or initial [00 00 00 03] [00 type] [id:2]
    // The separator byte before [00 type] is 0x2b (+), 0x2d (-), or 0x01
    
    // Handle first entity (with or without 00000003 header)
    if (block.readUInt32BE(0) === 3 && block.length >= 8) {
        const type = block.readUInt16BE(4);
        const id = block.readUInt16BE(6);
        allEntities.push({ type, id, blockIdx: i, subIdx: 0 });
    }
    
    // Scan for sub-records
    let subIdx = 1;
    for (let j = 8; j + 3 < block.length; j++) {
        const prevByte = block[j - 1];
        // Accept only known separator bytes
        if (prevByte !== 0x2b && prevByte !== 0x2d && prevByte !== 0x01) continue;
        
        if (block[j] === 0x00) {
            const typeCode = block[j + 1];
            if (typeCode < 0x0e || typeCode > 0x32) continue;
            const subId = block.readUInt16BE(j + 2);
            if (subId < 1 || subId > 5000) continue;
            
            allEntities.push({ type: typeCode, id: subId, blockIdx: i, subIdx: subIdx++ });
        }
    }
}

// Census
const census = new Map();
for (const e of allEntities) {
    census.set(e.type, (census.get(e.type) || 0) + 1);
}

console.log(`Total entities found: ${allEntities.length}`);
for (const [type, count] of [...census.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  type 0x${type.toString(16).padStart(2, '0')} (${type}): ${count}`);
}

// Compare with STEP expectations
console.log('\n=== COMPARISON WITH STEP ===');
console.log(`  STEP expects 250 VERTEX_POINT → PS has ${census.get(0x1d) || 0} type-0x1D`);
console.log(`  STEP expects 370 EDGE_CURVE  → PS has ${census.get(0x10) || 0} type-0x10`);
console.log(`  STEP expects 740 ORIENT_EDGE → PS has ${census.get(0x12) || 0} type-0x12`);
console.log(`  STEP expects 174 EDGE_LOOP   → PS has ${census.get(0x13) || 0} type-0x13`);
console.log(`  STEP expects 139 ADV_FACE    → PS has ${census.get(0x0f) || 0} type-0x0F`);
console.log(`  STEP expects 1   CLOSED_SHELL→ PS has ${census.get(0x11) || 0} type-0x11`);
console.log(`  STEP expects 139 surfaces    → PS has ${(census.get(0x1e) || 0) + (census.get(0x1f) || 0)} type-0x1E/0x1F`);
