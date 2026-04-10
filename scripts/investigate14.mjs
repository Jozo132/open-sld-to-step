/**
 * investigate14.mjs — Parse the class definition block and attempt
 * schema-driven record decoding.
 *
 * Goal: Understand the class definition format well enough to:
 *  1. Map class IDs → field layouts (type sequences)
 *  2. Parse entity records using those layouts
 *  3. Extract topology references (FACE→SURFACE, EDGE→VERTEX, etc.)
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
        const compressedSize = buf.readUInt32LE(idx + 14);
        const decompressedSize = buf.readUInt32LE(idx + 18);
        const nameLength = buf.readUInt32LE(idx + 22);
        if (nameLength > 0 && nameLength < 1024 && compressedSize > 4 &&
            compressedSize < buf.length && decompressedSize > 4 && decompressedSize < 50_000_000) {
            const payloadOffset = idx + 26 + nameLength;
            const payloadEnd = payloadOffset + compressedSize;
            if (payloadEnd <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(payloadOffset, payloadEnd),
                        { maxOutputLength: decompressedSize + 1024 });
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

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: Parse the class-definition block structure              
// ═══════════════════════════════════════════════════════════════════════════════

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const fname = files.find(f => f.startsWith('nist_ctc_01'));
const ps = getLargestPS(join(dir, fname));
console.log(`File: ${fname}, buffer: ${ps.length} bytes\n`);

// Find schema end
const schIdx = ps.indexOf('SCH_', 0, 'ascii');
let schEnd = schIdx;
while (schEnd < ps.length && ps[schEnd] !== 0x00 && ps[schEnd] >= 0x20) schEnd++;
console.log(`Schema: ${ps.subarray(schIdx, schEnd).toString('ascii')}`);

// ── Parse the field-type schema block (right after SCH_...) ─────────────────
// The schema block defines "base classes" with type character sequences.
// Format appears to be: type-chars + length-byte + name + additional bytes
// Type chars: C=class-ref, I=int, d=double, D=unknown, A=array/struct, R=array, Z=end

console.log('\n=== PARSING SCHEMA/FIELD DEFINITIONS ===\n');

// Scan from schema end for field definitions
// Each definition appears to be: <type-chars> <name-length> <name> <extra-bytes>
let pos = schEnd + 1; // skip null terminator
const fieldDefs = [];
const maxScan = Math.min(pos + 2000, ps.length);

while (pos < maxScan) {
    const b = ps[pos];
    
    // Check if we're at a type-character sequence
    const typeChars = 'CIdDAR'.split('');
    if (typeChars.includes(String.fromCharCode(b))) {
        // Read type sequence
        let types = '';
        let tp = pos;
        while (tp < maxScan && typeChars.includes(String.fromCharCode(ps[tp]))) {
            types += String.fromCharCode(ps[tp]);
            tp++;
        }
        
        // Next byte(s) should be name length + name
        if (tp < maxScan) {
            const nameLen = ps[tp];
            if (nameLen > 0 && nameLen < 100 && tp + 1 + nameLen <= maxScan) {
                const name = ps.subarray(tp + 1, tp + 1 + nameLen).toString('ascii');
                // Check if name is printable
                if (/^[\x20-\x7e]+$/.test(name)) {
                    fieldDefs.push({ offset: pos, types, name, nameLen });
                    pos = tp + 1 + nameLen;
                    continue;
                }
            }
        }
    }
    
    // Check for 'Z' (end marker)
    if (b === 0x5a) { // 'Z'
        fieldDefs.push({ offset: pos, types: 'Z', name: '<END>', nameLen: 0 });
    }
    
    pos++;
}

console.log(`Found ${fieldDefs.length} field definitions:`);
for (const fd of fieldDefs) {
    console.log(`  0x${fd.offset.toString(16)}: types=[${fd.types}] name="${fd.name}"`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Parse the named class definition block (BODY_MATCH, etc.)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== NAMED CLASS DEFINITIONS ===\n');

// Look for class definition pattern: name + 0x00 + 0x50/0x4F/0x51 + metadata
// The 0x50 byte seems to mark a "class inheriting from base" (P = parent?)
// 0x4F = 'O' and 0x51 = 'Q' may be other class types

const classDefPattern = /[\x20-\x7e]{3,50}/;
const classDefs = [];
pos = 0x200; // class defs start around here

while (pos < 0x800 && pos < ps.length) {
    // Look for an ASCII string followed by null + type byte
    let strStart = -1;
    for (let i = pos; i < Math.min(pos + 200, ps.length); i++) {
        if (ps[i] >= 0x41 && ps[i] <= 0x7a) { // A-z
            if (strStart < 0) strStart = i;
        } else if (ps[i] === 0x00 && strStart >= 0 && i - strStart >= 3) {
            const name = ps.subarray(strStart, i).toString('ascii');
            if (/^[A-Za-z0-9_\/]+$/.test(name)) {
                // Read metadata bytes after the null
                const typeByte = ps[i + 1]; // 0x50='P', 0x4F='O', 0x51='Q'
                const meta = ps.subarray(i + 1, Math.min(i + 25, ps.length));
                const metaHex = [...meta].map(b => b.toString(16).padStart(2, '0')).join(' ');
                
                // Try to parse the class metadata
                // Pattern seems to be: type(1) flags(1) 00 00 00 count(1) 00 baseId(1) 00 startField(1) 00 endField(1) ...
                if (typeByte === 0x50 || typeByte === 0x4f || typeByte === 0x51) {
                    const classType = typeByte === 0x50 ? 'P' : typeByte === 0x4f ? 'O' : 'Q';
                    const flags = ps[i + 2];
                    const extra = ps.readUInt16BE(i + 3);
                    const count = ps[i + 5];
                    // Bytes 6-7: 00 XX (looks like parent class ID)
                    const parentId = ps.readUInt16BE(i + 6);
                    // Bytes 8-9, 10-11: start/end field IDs?
                    const fieldStart = ps.readUInt16BE(i + 8);
                    const fieldEnd = ps.readUInt16BE(i + 10);
                    
                    classDefs.push({
                        name, offset: strStart, classType, flags,
                        extra, count, parentId, fieldStart, fieldEnd,
                        metaHex,
                    });
                }
                
                pos = i + 20;
                break;
            }
            strStart = -1;
        } else if (ps[i] < 0x20 || ps[i] > 0x7e) {
            strStart = -1;
        }
    }
    pos++;
}

console.log(`Found ${classDefs.length} named classes:`);
for (const cd of classDefs) {
    console.log(`  0x${cd.offset.toString(16)}: "${cd.name}" type=${cd.classType} flags=0x${cd.flags.toString(16)} count=${cd.count} parent=${cd.parentId} fields=${cd.fieldStart}..${cd.fieldEnd}`);
    console.log(`    meta: ${cd.metaHex}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Try to identify record structure via the "repeated pattern" approach
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== RECORD STRUCTURE DETECTION ===\n');

// In the marker file, records start with =p or =q + 3 tag bytes.
// The tag bytes always start with the SAME byte sequence as the float64 
// coordinate that comes later in the record (look at a3 d6 records).
// 
// Wait — the tag bytes (a3 d6 fa, a3 d6 fc) look like they might be
// partial float64 or some other encoding. Let's check if the 3 tag bytes
// are actually the first 3 bytes of a float64.
//
// For =p at 0x803: tag = a3 d6 fa
// Including preceding 2 bytes of marker: 3d 70 a3 d6 fa
// If we read float64 BE starting at marker: 3d 70 a3 d6 fa 00 1d 00 = ?
//   0x3d70a3d6fa001d00 → float64 ≈ 9.48e-13 (tiny, plausible as "nothing")
//
// Or maybe the 3 tag bytes ARE part of the data and the "=p" is just 2 bytes.
// Let me re-examine: if data starts at marker+2 (not marker+5):

console.log('Re-examining =p record starting byte offsets:');
const markers = [];
for (let i = 0; i < ps.length - 1; i++) {
    if (ps[i] === 0x3d && (ps[i+1] === 0x70 || ps[i+1] === 0x71))
        markers.push(i);
}

// For first few records, try parsing data at marker+2 instead of marker+5
// and see if the entities make more sense
for (const mi of [0, 1, 2, 3, 4]) {
    if (mi >= markers.length) break;
    const off = markers[mi];
    const nextOff = mi + 1 < markers.length ? markers[mi+1] : off + 200;
    const type = ps[off+1] === 0x70 ? 'p' : 'q';
    
    console.log(`\n--- =${type}[${mi}] @0x${off.toString(16)} (${nextOff - off} bytes) ---`);
    
    // Try reading from marker+2 (record data starts right after '=p' or '=q')
    const dataStart = off + 2;
    console.log('  At +2: ');
    
    // Try series of int16 BE reads
    const ints = [];
    for (let j = 0; j + 2 <= nextOff - dataStart && ints.length < 30; j += 2) {
        const v = ps.readUInt16BE(dataStart + j);
        ints.push(v);
    }
    console.log(`    int16s: [${ints.slice(0, 20).join(', ')}]`);
    
    // Try reading: [3-byte-tag] [sequence of int16 + float64 values]
    // The first =p at 0x638 is the big one (459 bytes) — let's parse it differently
    if (mi === 0) {
        console.log('\n  Special analysis of the first (large) record:');
        const d = ps.subarray(dataStart, nextOff);
        console.log(`    Bytes 0-2 (tag?): ${[...d.subarray(0, 3)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        
        // Try: 3 bytes tag, then 8 zero bytes, then sequence of float64 BE
        console.log(`    Bytes 3-10: ${[...d.subarray(3, 11)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        
        // Read all float64 BE from offset 3 onwards
        console.log('    Float64 BE every 8 bytes from +3:');
        for (let j = 3; j + 8 <= d.length && j < 3 + 200; j += 8) {
            const v = d.readDoubleBE(j);
            if (isFinite(v) && v !== 0) {
                console.log(`      +${j}: ${v.toPrecision(10)} (${v.toFixed(6)})`);
            } else {
                console.log(`      +${j}: ${v} [${[...d.subarray(j, j+8)].map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Analyze the "c2 bc 92 8f 99 6e 00 00" pattern
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== RECURRING BYTE PATTERNS ===');
const pattern = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
let patCount = 0;
let patIdx = 0;
const patPositions = [];
while ((patIdx = ps.indexOf(pattern, patIdx)) >= 0) {
    patPositions.push(patIdx);
    patCount++;
    patIdx++;
}
console.log(`Pattern c2 bc 92 8f 99 6e appears ${patCount} times`);
if (patPositions.length > 0) {
    console.log('First 15 positions:', patPositions.slice(0, 15).map(p => `0x${p.toString(16)}`).join(', '));
    // What's the float64 BE value?
    if (patPositions[0] + 8 <= ps.length) {
        const val = ps.readDoubleBE(patPositions[0]);
        console.log(`As float64 BE (8 bytes from first occurrence): ${val}`);
    }
    // Gaps between occurrences
    const pGaps = [];
    for (let i = 1; i < Math.min(patPositions.length, 20); i++) {
        pGaps.push(patPositions[i] - patPositions[i-1]);
    }
    console.log('Gaps between occurrences:', pGaps.join(', '));
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Try to understand record field structure by comparing multiple records
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== RECORD FIELD ALIGNMENT ANALYSIS ===');
console.log('(Looking for consistent field boundaries across records)\n');

// Take records 1-10 (markers-based), align them, find field boundaries
const recordData = [];
for (let mi = 1; mi < Math.min(11, markers.length); mi++) {
    const off = markers[mi];
    const nextOff = mi + 1 < markers.length ? markers[mi+1] : off + 200;
    const len = nextOff - off;
    const d = ps.subarray(off + 2, nextOff); // skip =p/=q marker
    recordData.push({ idx: mi, offset: off, len, data: d });
}

// Many records seem to be 40 or 68 bytes. Let's focus on the 68-byte ones
const rec68 = recordData.filter(r => r.len >= 66 && r.len <= 70);
console.log(`Records with ~68 bytes: ${rec68.length}`);

if (rec68.length >= 2) {
    // Compare field-by-field: try treating every 2 bytes as int16 BE
    for (const r of rec68.slice(0, 5)) {
        const d = r.data;
        const values = [];
        for (let j = 0; j + 2 <= d.length; j += 2) {
            values.push(d.readUInt16BE(j));
        }
        console.log(`  rec[${r.idx}] @0x${r.offset.toString(16)} (${d.length}b): [${values.join(', ')}]`);
    }
    
    console.log('\n  Trying mixed int16 + float64 parsing:');
    for (const r of rec68.slice(0, 5)) {
        const d = r.data;
        // Theory: 3 bytes tag + then field data
        // The records with =p tag a3 d6 fa seem to have:
        //   +0: tag[3] = a3 d6 fa  
        //   +3: int16 count/type = 00 1d (29) or 00 12 (18)
        //   +5: int16 entityRef = 00 XX
        //   +7: int16 ? = 00 00
        //   +9: int16 ? = 10 XX (flags?)
        //   +11: int16 entityRef = 00 01
        //   +13: int16 entityRef = 00 XX
        //   +15: int16 entityRef = 00 XX
        //   +17: int16 entityRef = 00 XX
        //   +19: int16 entityRef = 00 XX
        //   +21: float64 BE = 8 bytes
        //   +29: float64 BE = 8 bytes
        //   +37: float64 BE = 8 bytes
        //   ... (more entity data)
        
        console.log(`\n  rec[${r.idx}] mixed parse:`);
        const tag = [...d.subarray(0, 3)].map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`    tag: ${tag}`);
        
        // Parse known int16 BE fields
        if (d.length > 20) {
            const f1 = d.readUInt16BE(3); // count/type
            const f2 = d.readUInt16BE(5); // entity ref
            const f3 = d.readUInt16BE(7); // ?
            const f4 = d.readUInt16BE(9); // ?
            const f5 = d.readUInt16BE(11); // 00 01 → always 1?
            const f6 = d.readUInt16BE(13); // entity ref
            const f7 = d.readUInt16BE(15); // entity ref  
            const f8 = d.readUInt16BE(17); // entity ref
            const f9 = d.readUInt16BE(19); // entity ref
            console.log(`    int16s: ${f1}, ${f2}, ${f3}, ${f4}, ${f5}, ${f6}, ${f7}, ${f8}, ${f9}`);
            
            // Try float64 at various positions
            for (const fStart of [21, 29, 37, 45, 53]) {
                if (fStart + 8 <= d.length) {
                    const v = d.readDoubleBE(fStart);
                    console.log(`    float64@+${fStart}: ${v.toFixed(6)}`);
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6: Cross-reference entity IDs to build topology chains
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TOPOLOGY CHAIN ANALYSIS ===');
console.log('(Trying to find BODY→SHELL→FACE→EDGE→VERTEX chains)\n');

// In the first big record (=p[0] at 0x638), we have 459 bytes.
// This likely contains the body/shell/face definitions.
// Let's parse it more carefully.
const bigRecOff = markers[0];
const bigRecEnd = markers.length > 1 ? markers[1] : bigRecOff + 500;
const bigRec = ps.subarray(bigRecOff + 2, bigRecEnd);
console.log(`First (big) record: ${bigRec.length} bytes`);

// Dump as mixed int16 + float64, looking for patterns
console.log('\nFull dump as alternating int16-BE (with float64 candidates):');
let cursor = 3; // skip 3-byte tag
while (cursor + 2 <= bigRec.length && cursor < 200) {
    const v16 = bigRec.readUInt16BE(cursor);
    
    // Check if this could be the start of a float64
    let isFloat = false;
    if (cursor + 8 <= bigRec.length) {
        const fv = bigRec.readDoubleBE(cursor);
        if (isFinite(fv) && fv !== 0 && Math.abs(fv) > 0.0001 && Math.abs(fv) < 1e6) {
            console.log(`  +${cursor}: FLOAT64=${fv.toFixed(6)} [${[...bigRec.subarray(cursor, cursor+8)].map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
            cursor += 8;
            isFloat = true;
        }
    }
    
    if (!isFloat) {
        console.log(`  +${cursor}: INT16=${v16} (0x${v16.toString(16)}) [${[...bigRec.subarray(cursor, cursor+2)].map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
        cursor += 2;
    }
}
