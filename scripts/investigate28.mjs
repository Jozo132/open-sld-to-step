/**
 * investigate28.mjs — Decode ALL records between sentinels.
 * The sentinel blocks contain multiple sub-records. Need to understand ALL entity types.
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

function isParasolid(buf) {
    return buf.length >= 20 && buf[0] === 0x50 && buf[1] === 0x53 &&
           buf.indexOf('TRANSMIT', 0, 'ascii') >= 0 && buf.indexOf('TRANSMIT', 0, 'ascii') < 32;
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
                        try { const n = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 }); if (isParasolid(n) && (!best || n.length > best.length)) best = n; } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

function hexDump(buf, len = 64) {
    return [...buf.subarray(0, len)].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

// Load ctc_01 which we understand best
const ps = getLargestPS(join(sldDir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
console.log(`PS buffer: ${ps.length} bytes\n`);

// Find all sentinel positions
const sentPositions = [];
let idx = 0;
while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx++; }
console.log(`Sentinels: ${sentPositions.length}\n`);

// Extract blocks between sentinels
const blocks = [];
for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + 6; // after sentinel
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
    blocks.push({ start: blockStart, data: ps.subarray(blockStart, blockEnd) });
}

// Analyze what each block looks like
// Group by the first 4 bytes (header word)
const headerTypes = new Map();
for (const block of blocks) {
    if (block.data.length < 4) continue;
    const header4 = block.data.readUInt32BE(0);
    const key = header4.toString(16).padStart(8, '0');
    if (!headerTypes.has(key)) headerTypes.set(key, []);
    headerTypes.get(key).push(block);
}

console.log(`Block header types (first 4 bytes):`);
for (const [key, blocks] of [...headerTypes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const hex = key.match(/.{2}/g).join(' ');
    console.log(`  ${hex}: ${blocks.length} blocks (avg size: ${Math.round(blocks.reduce((s, b) => s + b.data.length, 0) / blocks.length)})`);
    
    // Show first example
    if (blocks.length <= 3 || ['00000003'].includes(key)) {
        for (const b of blocks.slice(0, 2)) {
            console.log(`    @0x${b.start.toString(16)}: ${hexDump(b.data, Math.min(80, b.data.length))}`);
        }
    }
}

// Now let's carefully parse the 00000003 blocks which contain entity records
console.log(`\n${'='.repeat(70)}`);
console.log(`PARSING 00000003 BLOCKS`);
console.log(`${'='.repeat(70)}\n`);

const entityBlocks = headerTypes.get('00000003') || [];
console.log(`Total 00000003 blocks: ${entityBlocks.length}\n`);

// Each block: [00 00 00 03] [type:2] [id:2] [data...]
// In the data, there may be additional records without sentinel separators
// Let's look at the full structure of each block

// Categorize by entity type (bytes 4-5)
const byType = new Map();
for (const block of entityBlocks) {
    if (block.data.length < 6) continue;
    const type = block.data.readUInt16BE(4);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(block);
}

console.log(`Entity types in 00000003 blocks:`);
for (const [type, blocks] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  TYPE 0x${type.toString(16)} (${type}): ${blocks.length} entities`);
    
    // Show first few blocks with decoded fields
    for (const b of blocks.slice(0, 3)) {
        const id = b.data.readUInt16BE(6);
        console.log(`    id=${id} len=${b.data.length} hex: ${hexDump(b.data, Math.min(80, b.data.length))}`);
        
        // For type 0x1d (point): decode coordinates
        if (type === 0x1d && b.data.length >= 32) {
            const x = b.data.readDoubleBE(20);
            const y = b.data.readDoubleBE(28);
            const z = b.data.readDoubleBE(36);
            console.log(`      coords: (${x}, ${y}, ${z})`);
        }
    }
}

// Now let's look at the non-00000003 blocks more carefully
// They might be continuation records or different entity types
console.log(`\n${'='.repeat(70)}`);
console.log(`PARSING NON-00000003 BLOCKS`);
console.log(`${'='.repeat(70)}\n`);

for (const [key, blocks] of [...headerTypes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (key === '00000003') continue;
    
    console.log(`\nHEADER ${key.match(/.{2}/g).join(' ')} (${blocks.length} blocks):`);
    
    // Are these entity records too? Check if bytes 4-5 look like a type
    for (const b of blocks.slice(0, 5)) {
        const len = b.data.length;
        console.log(`  @0x${b.start.toString(16)} len=${len}: ${hexDump(b.data, Math.min(80, len))}`);
        
        // Try to find sub-records within the block
        // Look for [00 XX] patterns that could be entity type markers
        if (len > 8) {
            // Check if bytes 0-1 form a type-like value
            const word0 = b.data.readUInt16BE(0);
            const word1 = b.data.readUInt16BE(2);
            if (word0 <= 0x40) { // small type value
                console.log(`    possible type=${word0} id=${word1}`);
            }
        }
    }
}

// Let's also examine what comes AFTER type-0x1d records within a block
// From the hex dumps, we saw that coedge records (00 12) follow the point coords
console.log(`\n${'='.repeat(70)}`);
console.log(`SUB-RECORD PARSING IN 00000003 BLOCKS`);
console.log(`${'='.repeat(70)}\n`);

// Parse all entities from 00000003 blocks, including sub-records
function parseSubRecords(data) {
    const records = [];
    let off = 0;
    
    // First record has full header: [00 00 00 03] [type:2] [id:2]
    if (data.length < 8) return records;
    const hdr = data.readUInt32BE(0);
    if (hdr !== 3) return records;
    
    const type1 = data.readUInt16BE(4);
    const id1 = data.readUInt16BE(6);
    records.push({ type: type1, id: id1, offset: 0 });
    
    // Now scan for sub-records. They start with [00 type_byte] where type is in known range
    // Known types: 0x0f(face), 0x10(edge), 0x11(body/region/shell), 0x12(coedge), 
    //              0x1d(point), 0x1e(surface/curve), 0x1f(?)
    off = 8;
    while (off < data.length - 3) {
        // Check for [00 type:1] [id:2] pattern
        if (data[off] === 0x00) {
            const possibleType = data[off + 1];
            if (possibleType >= 0x0f && possibleType <= 0x3f && off + 4 <= data.length) {
                const possibleId = data.readUInt16BE(off + 2);
                // Validate: ID should be reasonable (>0 and not too large)
                if (possibleId > 0 && possibleId < 10000) {
                    records.push({ type: possibleType, id: possibleId, offset: off });
                    off += 4;
                    continue;
                }
            }
        }
        off++;
    }
    
    return records;
}

// Count sub-record types across all blocks
const subTypeCount = new Map();
let totalSubRecords = 0;
for (const block of entityBlocks) {
    const subs = parseSubRecords(block.data);
    for (const sub of subs) {
        subTypeCount.set(sub.type, (subTypeCount.get(sub.type) || 0) + 1);
        totalSubRecords++;
    }
}

console.log(`Total sub-records found: ${totalSubRecords}`);
console.log(`Sub-record types:`);
for (const [type, count] of [...subTypeCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  type 0x${type.toString(16)} (${type}): ${count}`);
}

// Show example of sub-records in a block
console.log(`\nExample blocks with sub-records:`);
for (const block of entityBlocks.slice(0, 5)) {
    const subs = parseSubRecords(block.data);
    console.log(`  Block @0x${block.start.toString(16)} (${block.data.length} bytes):`);
    for (const sub of subs) {
        console.log(`    type=0x${sub.type.toString(16)} id=${sub.id} @+${sub.offset}`);
    }
}

// Focus: what are the non-00000003 sentinel blocks?
// Let's look at every unique first-byte pattern
console.log(`\n${'='.repeat(70)}`);
console.log(`FIRST BYTE ANALYSIS OF ALL SENTINEL BLOCKS`);
console.log(`${'='.repeat(70)}\n`);

const firstBytes = new Map();
for (const block of blocks) {
    if (block.data.length < 2) continue;
    const fb = block.data[0];
    if (!firstBytes.has(fb)) firstBytes.set(fb, { count: 0, examples: [] });
    const entry = firstBytes.get(fb);
    entry.count++;
    if (entry.examples.length < 3) {
        entry.examples.push({ start: block.start, len: block.data.length, hex: hexDump(block.data, 32) });
    }
}

for (const [fb, info] of [...firstBytes.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  First byte 0x${fb.toString(16).padStart(2, '0')}: ${info.count} blocks`);
    for (const ex of info.examples) {
        console.log(`    @0x${ex.start.toString(16)} len=${ex.len}: ${ex.hex}`);
    }
}

// Critical: look for entity records that DON'T have the 00 00 00 03 prefix
// These might be the coedge/edge/face records that are their own sentinel blocks
console.log(`\n${'='.repeat(70)}`);
console.log(`NON-03 SENTINEL BLOCKS — WHAT ARE THEY?`);
console.log(`${'='.repeat(70)}\n`);

// Blocks starting with 00 but not 00 00 00 03
const nonStdBlocks = blocks.filter(b => b.data.length >= 6 && b.data[0] === 0x00 && b.data.readUInt32BE(0) !== 3);
console.log(`Blocks starting with 0x00 but not 0x00000003: ${nonStdBlocks.length}`);
for (const b of nonStdBlocks.slice(0, 10)) {
    const word = b.data.readUInt32BE(0).toString(16).padStart(8, '0');
    console.log(`  @0x${b.start.toString(16)} header=${word} len=${b.data.length}: ${hexDump(b.data, 48)}`);
}

// Blocks NOT starting with 0x00 at all
const nonZeroBlocks = blocks.filter(b => b.data.length > 0 && b.data[0] !== 0x00);
console.log(`\nBlocks NOT starting with 0x00: ${nonZeroBlocks.length}`);
for (const b of nonZeroBlocks.slice(0, 10)) {
    const word = b.data.readUInt32BE(0).toString(16).padStart(8, '0');
    console.log(`  @0x${b.start.toString(16)} header=${word} len=${b.data.length}: ${hexDump(b.data, 48)}`);
}

// Hypothesis: sentinel blocks that aren't 00000003 might be "continuation" blocks
// for multi-entity records (like geometry data: curves, surfaces)
// Let's check: what comes BEFORE a non-00000003 block?
console.log(`\n${'='.repeat(70)}`);
console.log(`CONTEXT: WHAT's BEFORE NON-00000003 BLOCKS?`);
console.log(`${'='.repeat(70)}\n`);

for (const b of nonStdBlocks.slice(0, 5)) {
    // Find previous sentinel block
    const blockIdx = blocks.indexOf(b);
    if (blockIdx > 0) {
        const prev = blocks[blockIdx - 1];
        console.log(`Block @0x${b.start.toString(16)} (header ${b.data.readUInt32BE(0).toString(16)})`);
        console.log(`  Previous block @0x${prev.start.toString(16)}: ${hexDump(prev.data, 48)}`);
        console.log(`  This block: ${hexDump(b.data, 48)}`);
        console.log('');
    }
}
