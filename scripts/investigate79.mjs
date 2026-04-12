#!/usr/bin/env node
/**
 * investigate79.mjs — Find topology entities using FF-format and Compact-format headers.
 *
 * The memory file describes two entity formats:
 * - FF-format: [type:int16] 0xFF [id:int16] [00 00] [flags:int16] [00 01] [data...]
 * - Compact format: [type:int16] [id:int16] [00 00] [flags:int16] [00 01] [data...]
 *
 * The current parser only finds entities via [00 00 00 03] [00 TYPE] [ID] primary
 * headers and sub-record separators, which misses most topology entities.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const FILE = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const buf = fs.readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
if (!result) { console.log('No PS data'); process.exit(1); }
const ps = result.data;
console.log(`PS buffer: ${ps.length} bytes`);

// ─── Sentinel positions for context ─────────────────────────────────────────
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const sentinels = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0) { sentinels.push(si); si += 6; }
console.log(`Sentinels: ${sentinels.length}`);

// ─── Search for FF-format entities: [00 TYPE] [FF] [ID_hi ID_lo] ──────────
// FF-format: [type:int16] 0xFF [id:int16] [00 00] [flags:int16] [00 01]
// For FACE (0x0F): [00 0F FF ...]
// For EDGE (0x10): [00 10 FF ...]
// For COEDGE (0x12): [00 12 FF ...]
// For LOOP (0x13): [00 13 FF ...]

const TYPES_OF_INTEREST = [
    { name: 'FACE', code: 0x0F },
    { name: 'EDGE', code: 0x10 },
    { name: 'SHELL', code: 0x11 },
    { name: 'COEDGE', code: 0x12 },
    { name: 'LOOP', code: 0x13 },
    { name: 'POINT', code: 0x1D },
    { name: 'CURVE', code: 0x1E },
    { name: 'SURFACE', code: 0x1F },
];

console.log('\n=== FF-format entities ([00 TYPE FF ...]) ===');
for (const { name, code } of TYPES_OF_INTEREST) {
    const pattern = Buffer.from([0x00, code, 0xFF]);
    const positions = [];
    let idx = 0;
    while ((idx = ps.indexOf(pattern, idx)) >= 0) {
        // Validate: check [00 00] [flags_hi flags_lo] [00 01] at offsets +5..+10
        const off = idx;
        if (off + 10 < ps.length) {
            const id = ps.readUInt16BE(off + 3);
            const null1 = ps[off + 5];
            const null2 = ps[off + 6];
            const flag1 = ps[off + 7];
            const flag2 = ps[off + 8];
            const end1 = ps[off + 9];
            const end2 = ps[off + 10];
            
            // Validate: [00 00] then [?? ??] then [00 01]
            if (null1 === 0x00 && null2 === 0x00 && end1 === 0x00 && end2 === 0x01) {
                positions.push({ pos: off, id, flags: (flag1 << 8) | flag2 });
            }
        }
        idx += 1;
    }
    console.log(`  ${name} (0x${code.toString(16).padStart(2,'0')}): ${positions.length} FF-format entities`);
    if (positions.length > 0 && positions.length <= 5) {
        for (const p of positions.slice(0, 3)) {
            console.log(`    @${p.pos} id=${p.id} flags=${p.flags}`);
        }
    }
}

// ─── Search for compact-format entities ──────────────────────────────────
// Compact: [00 TYPE] [ID_hi ID_lo] [00 00] [flags_hi flags_lo] [00 01]
// For this we need to scan all [00 TYPE] patterns and validate the structure

console.log('\n=== Compact-format entities ([00 TYPE ID ID 00 00 FLAGS FLAGS 00 01]) ===');
for (const { name, code } of TYPES_OF_INTEREST) {
    const positions = [];
    for (let i = 0; i < ps.length - 9; i++) {
        if (ps[i] !== 0x00 || ps[i + 1] !== code) continue;
        
        // Check if followed by: [id:2] [00 00] [flags:2] [00 01]
        if (ps[i + 4] !== 0x00 || ps[i + 5] !== 0x00) continue;
        if (ps[i + 8] !== 0x00 || ps[i + 9] !== 0x01) continue;
        
        const id = ps.readUInt16BE(i + 2);
        const flags = ps.readUInt16BE(i + 6);
        
        // Sanity checks:
        // - Don't match inside sentinel bytes or at odd positions
        // - ID should be reasonable (1-65000)
        if (id === 0) continue; // null is not an entity
        if (id > 60000) continue; // unlikely entity ID
        
        positions.push({ pos: i, id, flags });
    }
    console.log(`  ${name} (0x${code.toString(16).padStart(2,'0')}): ${positions.length} compact-format entities`);
    if (positions.length > 0) {
        for (const p of positions.slice(0, 5)) {
            const hexAfter = [...ps.subarray(p.pos + 10, Math.min(p.pos + 40, ps.length))]
                .map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`    @${p.pos} id=${p.id} flags=${p.flags} data: ${hexAfter}`);
        }
        if (positions.length > 5) {
            console.log(`    ... and ${positions.length - 5} more`);
        }
    }
}

// ─── Alternative: scan for [00 TYPE 00 ID_hi ID_lo 00 00] pattern ──────
// Maybe type byte is followed directly by 00 then ID
console.log('\n=== Alt format: entities after sentinel + 00 00 ===');

// After each sentinel, the next entity can be a primary [00 00 00 03 00 TYPE ID ID]
// But there may be OTHER entities embedded between sentinels
// Let's look at what's between consecutive sentinels

console.log(`\nSentinel gap analysis (first 50):`);
for (let i = 0; i < Math.min(50, sentinels.length - 1); i++) {
    const gap = sentinels[i + 1] - (sentinels[i] + 6);
    if (gap > 20 && gap < 200) continue; // skip common sizes
    if (gap > 200) {
        console.log(`  Gap ${i}: ${gap} bytes @${sentinels[i] + 6}`);
    }
}

// The key insight from the memory: entities are NOT always in separate blocks.
// The memory describes an interleaved pattern in the "sentinel zone":
//   [type-16 header: 10B] [sentinel (part of data)] [6 refs: 12B]
//   [type-30/31 geometry entity]
//   [type-18 header: 18B] [sentinel (terminator)]
//   [type-29 entity: 42B (in gap)]

// So the sentinel appears WITHIN entity data for type-16 (EDGE) entities,
// and as a TERMINATOR for type-18 (COEDGE) entities.

// Let's look at what's IMMEDIATELY before each sentinel
console.log(`\n=== What's before each sentinel (first 20) ===`);
for (let i = 0; i < Math.min(20, sentinels.length); i++) {
    const sentPos = sentinels[i];
    if (sentPos < 20) continue;
    const before = ps.subarray(sentPos - 20, sentPos);
    const hex = [...before].map(b => b.toString(16).padStart(2, '0')).join(' ');
    
    // Check for known patterns before the sentinel
    // If this is a type-16 entity's data, the sentinel is at offset+10 from entity header
    // Entity header would be at sentPos - 10
    const possibleType = ps[sentPos - 9]; // type byte in compact format
    const possibleType2 = ps[sentPos - 8]; // type byte in [00 00 00 03 00 TYPE]
    
    console.log(`  Sent[${i}] @${sentPos}: ...${hex.slice(-36)} | type?=0x${possibleType.toString(16)}/0x${possibleType2.toString(16)}`);
}

// ─── Direct scan: look for ALL [00 0F] (FACE type) in the buffer ──────────
console.log('\n=== All [00 0F] occurrences in sentinel zone ===');
const sentStart = sentinels[0];
const sentEnd = sentinels[sentinels.length - 1] + 6;
let facePatternCount = 0;
for (let i = sentStart; i < sentEnd - 1; i++) {
    if (ps[i] === 0x00 && ps[i + 1] === 0x0F) {
        facePatternCount++;
        if (facePatternCount <= 20) {
            const ctx = [...ps.subarray(Math.max(0, i - 4), Math.min(ps.length, i + 12))]
                .map(b => b.toString(16).padStart(2, '0')).join(' ');
            // Find nearest sentinel
            let nearestSent = -1;
            for (const s of sentinels) {
                if (Math.abs(s - i) < Math.abs(nearestSent - i) || nearestSent < 0) nearestSent = s;
            }
            console.log(`  @${i} (sent@${nearestSent}, d=${i - nearestSent}): ${ctx}`);
        }
    }
}
console.log(`Total [00 0F] in sentinel zone: ${facePatternCount}`);

// ─── Key: Check what pairs with [00 03 00 1E] entity starts ─────────────────
// Since geometry entities (0x1E, 0x1F) are sub-records within sentinel blocks,
// and topology entities (EDGE, COEDGE) are primary entities, let's find
// ALL primary entity types in sentinel blocks

console.log('\n=== Primary entity types in sentinel blocks ===');
const primaryTypes = {};
for (let i = 0; i < sentinels.length; i++) {
    const sentPos = sentinels[i];
    // Primary entity header should end at sentPos (sentinel is after header)
    // Header: [?? ?? ?? ?? type_hi type_lo id_hi id_lo] then data, then sentinel
    // OR: sentinel starts the block, then after sentinel we have [00 00 00 03 00 TYPE ID ID] data
    
    // After sentinel: check first 8 bytes
    const after = sentPos + 6;
    if (after + 8 > ps.length) continue;
    
    const magic = ps.readUInt32BE(after);
    if (magic === 3) {
        // [00 00 00 03] primary entity
        const type = ps[after + 5];
        primaryTypes[type] = (primaryTypes[type] || 0) + 1;
    }
}

console.log('  Types found as primary entities [00 00 00 03]:');
for (const [type, count] of Object.entries(primaryTypes).sort((a, b) => b[1] - a[1])) {
    const t = parseInt(type);
    console.log(`    0x${t.toString(16).padStart(2, '0')}: ${count}`);
}

// ─── What about entities BEFORE sentinels? ─────────────────────────────────
// The memory says EDGE is: 10B header + sentinel + 6 refs
// So the entity header is 10B BEFORE the sentinel, and the sentinel is PART OF the entity
console.log('\n=== Entities BEFORE sentinels (10B before) ===');
const beforeTypes = {};
for (let i = 0; i < sentinels.length; i++) {
    const sentPos = sentinels[i];
    if (sentPos < 10) continue;
    
    // FF-format: [00 TYPE FF 00 ID 00 00 FLAGS FLAGS 00 01]
    // Check at sentPos - 10 for FF-format  
    const headPos = sentPos - 10;
    if (ps[headPos] === 0x00 && ps[headPos + 2] === 0xFF &&
        ps[headPos + 5] === 0x00 && ps[headPos + 6] === 0x00 &&
        ps[headPos + 9] === 0x00 && ps[headPos + 10] === 0x01) {
        const type = ps[headPos + 1];
        beforeTypes[`FF-0x${type.toString(16)}`] = (beforeTypes[`FF-0x${type.toString(16)}`] || 0) + 1;
    }
    
    // Compact: [00 TYPE ID ID 00 00 FLAGS FLAGS 00 01]  
    if (ps[headPos] === 0x00 &&
        ps[headPos + 4] === 0x00 && ps[headPos + 5] === 0x00 &&
        ps[headPos + 8] === 0x00 && ps[headPos + 9] === 0x00) {
        const type = ps[headPos + 1];
        if (type >= 0x0F && type <= 0x20) {
            beforeTypes[`Cmp-0x${type.toString(16)}`] = (beforeTypes[`Cmp-0x${type.toString(16)}`] || 0) + 1;
        }
    }
}

console.log('  Entity types BEFORE sentinels:');
for (const [key, count] of Object.entries(beforeTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key}: ${count}`);
}
