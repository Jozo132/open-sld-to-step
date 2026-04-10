/**
 * investigate13.mjs — Schema-driven record parsing research
 *
 * Goal: Understand the Parasolid binary transmit schema structure well enough
 * to parse entity records structurally instead of brute-force float scanning.
 *
 * Approach:
 * 1. Parse the schema section (SCH_...) — field type descriptors
 * 2. Parse entity class definitions — map class IDs to field layouts
 * 3. Attempt to parse the first few entity records using the schema
 * 4. Compare results between marker-based and markerless files
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
// Analyze TWO files: one with markers, one without
// ═══════════════════════════════════════════════════════════════════════════════

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const markerFile = files.find(f => f.startsWith('nist_ctc_01'));  // has =p/=q
const noMarkerFile = files.find(f => f.startsWith('nist_ctc_03')); // no markers

for (const [label, fname] of [['MARKERS', markerFile], ['NO-MARKERS', noMarkerFile]]) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`FILE: ${fname} [${label}]`);
    console.log('═'.repeat(80));
    
    const ps = getLargestPS(join(dir, fname));
    if (!ps) { console.log('No PS data!'); continue; }
    console.log(`Buffer: ${ps.length} bytes\n`);
    
    // ── 1. Parse header ─────────────────────────────────────────────────────
    let headerEnd = 0;
    for (let i = 5; i < Math.min(ps.length, 256); i++) {
        if (ps[i] === 0x00) { headerEnd = i; break; }
    }
    const headerText = ps.subarray(0, headerEnd).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
    console.log(`Header: ${headerText}`);
    console.log(`Header ends at byte 0x${headerEnd.toString(16)}\n`);
    
    // ── 2. Parse schema ID ──────────────────────────────────────────────────
    const schIdx = ps.indexOf('SCH_', 0, 'ascii');
    let schEnd = schIdx;
    while (schEnd < ps.length && ps[schEnd] !== 0x00 && ps[schEnd] >= 0x20) schEnd++;
    const schemaId = ps.subarray(schIdx, schEnd).toString('ascii');
    console.log(`Schema: ${schemaId} (at 0x${schIdx.toString(16)}..0x${schEnd.toString(16)})\n`);
    
    // ── 3. Dump all bytes from schema end to byte 0x700 (class definition area) ──
    console.log('=== CLASS DEFINITION AREA (hex + ascii) ===');
    const classDefStart = schEnd;
    const classDefEnd = Math.min(ps.length, 0x700);
    
    // Look for ASCII strings in this area (class names)
    const classNames = [];
    let strStart = -1;
    for (let i = classDefStart; i < classDefEnd; i++) {
        const b = ps[i];
        if (b >= 0x41 && b <= 0x5a || b >= 0x61 && b <= 0x7a || b === 0x5f) { // A-Z, a-z, _
            if (strStart < 0) strStart = i;
        } else {
            if (strStart >= 0 && i - strStart >= 3) {
                const name = ps.subarray(strStart, i).toString('ascii');
                classNames.push({ name, offset: strStart, endByte: ps[i] });
            }
            strStart = -1;
        }
    }
    
    console.log(`Found ${classNames.length} text strings in class definition area:`);
    for (const cn of classNames) {
        // Show name + a few bytes after it
        const ctx = ps.subarray(cn.offset, Math.min(cn.offset + cn.name.length + 20, ps.length));
        const hexAfter = [...ctx.subarray(cn.name.length, cn.name.length + 20)]
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`  0x${cn.offset.toString(16)}: "${cn.name}" → [${hexAfter}]`);
    }
    
    // ── 4. Type code analysis ───────────────────────────────────────────────
    console.log('\n=== TYPE CODES IN CLASS DEFS ===');
    const typeCodes = { I: 0, d: 0, R: 0, A: 0, C: 0, Z: 0 };
    for (let i = classDefStart; i < classDefEnd; i++) {
        const ch = String.fromCharCode(ps[i]);
        if (ch in typeCodes) typeCodes[ch]++;
    }
    console.log('  Counts:', JSON.stringify(typeCodes));
    
    // ── 5. Hex dump of the transition from class defs → entity data ──
    // Find where entity records begin (first =p marker, or first large non-printable area)
    let dataAreaStart = classDefEnd;
    for (let i = classDefEnd; i < ps.length - 1; i++) {
        if (ps[i] === 0x3d && (ps[i+1] === 0x70 || ps[i+1] === 0x71)) {
            dataAreaStart = i;
            break;
        }
    }
    // If no markers, look for the transition point
    if (dataAreaStart === classDefEnd) {
        // Find last 'Z' byte in the first 4KB (end of class defs)
        for (let i = Math.min(0x1000, ps.length) - 1; i >= 0x60; i--) {
            if (ps[i] === 0x5a) { // 'Z'
                dataAreaStart = i + 1;
                break;
            }
        }
    }
    
    console.log(`\n=== DATA AREA begins at 0x${dataAreaStart.toString(16)} ===`);
    console.log('First 256 bytes of data area:');
    for (let off = dataAreaStart; off < Math.min(dataAreaStart + 256, ps.length); off += 32) {
        const slice = ps.subarray(off, Math.min(off + 32, ps.length));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        console.log(`  ${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
    
    // ── 6. Look for int16 BE patterns that could be entity IDs or class IDs ──
    console.log('\n=== ENTITY ID PATTERNS ===');
    // In Parasolid, entities reference each other by ID. Check if there are
    // sequential int16 BE values that could be auto-assigned entity IDs
    const firstData = ps.subarray(dataAreaStart, Math.min(dataAreaStart + 1000, ps.length));
    
    // Read all int16 BE values, look for small sequential numbers (1, 2, 3...)
    const smallInts = [];
    for (let i = 0; i < firstData.length - 1; i++) {
        const val = firstData.readInt16BE(i);
        if (val >= 1 && val <= 500) {
            smallInts.push({ offset: i + dataAreaStart, value: val });
        }
    }
    // Find clusters of sequential small ints (potential entity records with IDs)
    if (smallInts.length > 0) {
        console.log(`Found ${smallInts.length} small int16 BE (1-500) in first 1000 data bytes`);
        // Show the first 30
        for (const si of smallInts.slice(0, 30)) {
            console.log(`  0x${si.offset.toString(16)}: ${si.value}`);
        }
    }
    
    // ── 7. For marker-based file: analyze record structure ──────────────────
    if (label === 'MARKERS') {
        console.log('\n=== RECORD STRUCTURE ANALYSIS ===');
        const markers = [];
        for (let i = 0; i < ps.length - 1; i++) {
            if (ps[i] === 0x3d && (ps[i+1] === 0x70 || ps[i+1] === 0x71))
                markers.push(i);
        }
        
        // Analyze the bytes between each =p marker's tag and the data
        // =p is followed by 3 bytes — what are they?
        console.log('\nFirst 20 =p records — tag bytes analysis:');
        for (let mi = 0; mi < Math.min(20, markers.length); mi++) {
            const off = markers[mi];
            const type = ps[off+1] === 0x70 ? 'p' : 'q';
            const nextOff = mi + 1 < markers.length ? markers[mi+1] : off + 200;
            const recordLen = nextOff - off;
            
            // Show: marker type, 3 tag bytes, record length, first 40 data bytes
            const tagBytes = [...ps.subarray(off + 2, off + 5)]
                .map(b => b.toString(16).padStart(2, '0')).join(' ');
            const dataBytes = [...ps.subarray(off + 5, Math.min(off + 45, nextOff))]
                .map(b => b.toString(16).padStart(2, '0')).join(' ');
            
            // Try reading int16 BE value from bytes 2-3 (potential class ID)
            const possibleClassId = ps.readUInt16BE(off + 2);
            // Try reading int8 from byte 4 (potential field count)
            const possibleFieldCount = ps[off + 4];
            
            console.log(`  =${type}[${mi}] @0x${off.toString(16)} len=${recordLen} tag=[${tagBytes}] classId?=${possibleClassId} fieldCnt?=${possibleFieldCount}`);
            console.log(`    data: ${dataBytes}`);
            
            // Try to identify what the record contains by looking for float64 BE sequences
            const floats = [];
            for (let j = off + 5; j + 8 <= Math.min(nextOff, off + 200); j++) {
                const val = ps.readDoubleBE(j);
                if (isFinite(val) && Math.abs(val) > 0.001 && Math.abs(val) < 1e4) {
                    floats.push({ relOff: j - off, value: val });
                }
            }
            if (floats.length > 0) {
                console.log(`    BE floats: ${floats.slice(0, 8).map(f => `+${f.relOff}:${f.value.toFixed(6)}`).join(', ')}`);
            }
            
            // Look for int16/int32 BE values that could be entity references
            const intRefs = [];
            for (let j = off + 5; j + 2 <= Math.min(nextOff, off + 30); j++) {
                const v16 = ps.readUInt16BE(j);
                if (v16 >= 1 && v16 <= 200) {
                    intRefs.push({ relOff: j - off, value: v16 });
                }
            }
            if (intRefs.length > 0) {
                console.log(`    int16 refs: ${intRefs.map(r => `+${r.relOff}:${r.value}`).join(', ')}`);
            }
        }
    }
    
    // ── 8. For no-marker file: try to find record boundaries ────────────────
    if (label === 'NO-MARKERS') {
        console.log('\n=== MARKERLESS RECORD BOUNDARY SEARCH ===');
        
        // Strategy: look for repeating patterns that could be record delimiters
        // Try various 2-byte and 3-byte sequences
        const data = ps.subarray(dataAreaStart, ps.length);
        
        // Check if int16 BE entity IDs appear at regular intervals
        // Theory: each record starts with [classID:int16] [entityID:int16] [data...]
        
        // Find all positions where we see a small int16 followed by another small int16
        const doubleSm = [];
        for (let i = 0; i < Math.min(data.length, 5000) - 3; i++) {
            const v1 = data.readUInt16BE(i);
            const v2 = data.readUInt16BE(i + 2);
            if (v1 >= 1 && v1 <= 100 && v2 >= 1 && v2 <= 500) {
                doubleSm.push({ offset: i + dataAreaStart, classId: v1, entityId: v2 });
            }
        }
        console.log(`Double small-int16 pairs (classId 1-100, entityId 1-500): ${doubleSm.length}`);
        if (doubleSm.length > 0) {
            console.log('First 20:', doubleSm.slice(0, 20)
                .map(d => `0x${d.offset.toString(16)}: cls=${d.classId} id=${d.entityId}`)
                .join('\n  '));
        }
        
        // Check for byte 0x00 as possible record delimiter
        const nullPositions = [];
        for (let i = 0; i < Math.min(data.length, 5000); i++) {
            if (data[i] === 0x00) nullPositions.push(i + dataAreaStart);
        }
        console.log(`\nNull bytes in first 5KB of data: ${nullPositions.length}`);
        
        // Extract BE float64 triplets from the data area and see if they cluster
        // at regular intervals (which would reveal record size)
        const tripletOffsets = [];
        for (let i = 0; i + 24 <= data.length && tripletOffsets.length < 100; i++) {
            const x = data.readDoubleBE(i);
            const y = data.readDoubleBE(i + 8);
            const z = data.readDoubleBE(i + 16);
            if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
            if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) continue;
            const mx = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
            if (mx < 0.001) continue;
            if (x === 0 && y === 0 && z === 0) continue;
            tripletOffsets.push({
                absOff: i + dataAreaStart,
                relOff: i,
                x: x.toFixed(6), y: y.toFixed(6), z: z.toFixed(6)
            });
        }
        console.log(`\nBE float64 triplets in data area: ${tripletOffsets.length}`);
        if (tripletOffsets.length > 1) {
            // Compute gaps between consecutive triplet offsets
            const gaps = [];
            for (let i = 1; i < tripletOffsets.length; i++) {
                gaps.push(tripletOffsets[i].relOff - tripletOffsets[i-1].relOff);
            }
            // Find most common gaps
            const gapHist = new Map();
            for (const g of gaps) gapHist.set(g, (gapHist.get(g) || 0) + 1);
            const topGaps = [...gapHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
            console.log('Most common gaps between triplets:',
                topGaps.map(([g, c]) => `${g}bytes:${c}x`).join(', '));
            
            // Show first 20 triplets with their offsets
            console.log('\nFirst 20 triplets:');
            for (const t of tripletOffsets.slice(0, 20)) {
                console.log(`  0x${t.absOff.toString(16)} (+${t.relOff}): (${t.x}, ${t.y}, ${t.z})`);
            }
        }
    }
}
