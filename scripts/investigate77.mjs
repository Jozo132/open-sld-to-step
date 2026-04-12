#!/usr/bin/env node
/**
 * investigate77.mjs — Parse the Parasolid schema section to extract
 * class field definitions (field names, types, counts).
 * 
 * The schema starts after "SCH_..." and defines entity classes with
 * field type codes: C=class-ref, I=int, d=double, R=array, A=sub-struct, Z=end.
 *
 * Goal: Extract the field layout for FACE, EDGE, LOOP, COEDGE, VERTEX, SURFACE, CURVE
 * so that we can properly parse entity data with known field offsets.
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
const psBuf = result.data;
console.log(`PS buffer: ${psBuf.length} bytes`);

// Find schema start
const schIdx = psBuf.indexOf('SCH_');
if (schIdx < 0) { console.log('No schema found'); process.exit(1); }

// The schema section has variable encoding. Let's dump the raw bytes
// from the schema start through the first few thousand bytes to understand
// the class definitions.

// Extract printable/type-code tokens from the schema section
console.log(`\nSchema starts at offset ${schIdx}`);

// Read the schema ID
let endSch = schIdx;
while (endSch < psBuf.length && psBuf[endSch] !== 0x00 && psBuf[endSch] !== 0x0A) endSch++;
const schemaId = psBuf.subarray(schIdx, endSch).toString('ascii');
console.log(`Schema ID: ${schemaId}`);

// Now parse the schema section. The schema uses a compact binary encoding for
// type definitions. Let me dump bytes with annotations.

// Strategy: scan for known type codes and field name patterns
// Field names are ASCII strings followed by type codes

// Extended schema dump - extract all printable text segments
console.log('\n=== Schema raw analysis ===');

// Look for class definitions by finding Z-terminated blocks
// Each class has: [fields...] Z
// Fields are: <name_chars> <type_code>

// Let me scan for all printable ASCII strings >= 3 chars in the schema region
const schemaRegion = psBuf.subarray(schIdx, Math.min(schIdx + 5000, psBuf.length));

// Find the 'Z' markers which terminate field definitions  
const zPositions = [];
for (let i = 0; i < schemaRegion.length; i++) {
    if (schemaRegion[i] === 0x5A) { // 'Z'
        zPositions.push(i);
    }
}
console.log(`Z markers in schema region: ${zPositions.length} at offsets: ${zPositions.slice(0, 30).join(', ')}`);

// Let's do byte-by-byte analysis of the schema section
// Type codes are single ASCII chars: C(0x43), I(0x49), d(0x64), R(0x52), A(0x41), Z(0x5A)
// J(0x4A), Q(0x51), F(0x46), D(0x44), O(0x4F), P(0x50)

const TYPE_CODES = new Set([0x43, 0x49, 0x64, 0x52, 0x41, 0x5A, 0x4A, 0x51, 0x46, 0x44]);
// C=0x43, I=0x49, d=0x64, R=0x52, A=0x41, Z=0x5A, J=0x4A, Q=0x51, F=0x46, D=0x44

// Parse schema field definitions
function parseSchemaTokens(buf, start, end) {
    const tokens = [];
    let pos = start;
    
    while (pos < end) {
        const b = buf[pos];
        
        // Skip null bytes
        if (b === 0x00) { pos++; continue; }
        
        // Check for type code
        if (TYPE_CODES.has(b)) {
            tokens.push({ type: 'code', value: String.fromCharCode(b), offset: pos });
            pos++;
            continue;
        }
        
        // Check for printable ASCII string (field name)
        if (b >= 0x20 && b < 0x7F) {
            let str = '';
            let p = pos;
            while (p < end && buf[p] >= 0x20 && buf[p] < 0x7F && !TYPE_CODES.has(buf[p])) {
                str += String.fromCharCode(buf[p]);
                p++;
            }
            if (str.length > 0) {
                tokens.push({ type: 'name', value: str, offset: pos });
                pos = p;
                continue;
            }
        }
        
        // Non-printable byte
        tokens.push({ type: 'byte', value: b, offset: pos });
        pos++;
    }
    
    return tokens;
}

// First, let's understand the overall structure. 
// There appear to be two major blocks before the entity data starts.

// Block 1: After SCH_..., there's a class hierarchy definition
// Block 2: Named class definitions (BODY_MATCH, etc.) with P/O/Q markers

// Let's find where entity data starts by looking for the first entity sentinel
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const firstSentinel = psBuf.indexOf(SENTINEL);
console.log(`First sentinel at offset: ${firstSentinel}`);
console.log(`Schema region: ${schIdx} to ${firstSentinel} = ${firstSentinel - schIdx} bytes`);

// Parse tokens in the schema region
const tokens = parseSchemaTokens(psBuf, schIdx, Math.min(schIdx + 3000, firstSentinel || psBuf.length));

// Group tokens into field definitions (separated by Z markers)
console.log('\n=== Token stream (first 200) ===');
for (let i = 0; i < Math.min(200, tokens.length); i++) {
    const t = tokens[i];
    if (t.type === 'code') {
        process.stdout.write(`[${t.value}]`);
        if (t.value === 'Z') process.stdout.write('\n---\n');
    } else if (t.type === 'name') {
        process.stdout.write(` ${t.value} `);
    } else {
        process.stdout.write(`<${t.value.toString(16)}>`);
    }
}
console.log('\n');

// Now let's look specifically for entity class definitions
// After the schema type-code blocks, there are named class sections
// marked with P/O markers. Let's find them.

console.log('\n=== Named class definitions ===');

// Search for known class names in the schema region
const classNames = [
    'BODY', 'SHELL', 'FACE', 'LOOP', 'EDGE', 'COEDGE', 'FIN',
    'VERTEX', 'POINT', 'CURVE', 'SURFACE',
    'PLANE', 'LINE', 'CIRCLE', 'ELLIPSE', 'CONE', 'CYLINDER', 'SPHERE', 'TORUS',
    'B_SURFACE', 'B_CURVE', 'SWEPT', 'SPUN',
    'BODY_MATCH', 'ATTRIB', 'COLOUR'
];

for (const name of classNames) {
    let searchStart = schIdx;
    const indices = [];
    while (true) {
        const idx = psBuf.indexOf(name, searchStart, 'ascii');
        if (idx < 0 || idx > firstSentinel) break;
        indices.push(idx);
        searchStart = idx + 1;
    }
    if (indices.length > 0) {
        console.log(`  "${name}" found at offsets: ${indices.join(', ')}`);
        // Show context around first occurrence
        for (const idx of indices.slice(0, 2)) {
            const ctx = psBuf.subarray(Math.max(0, idx - 10), idx + name.length + 30);
            const hex = [...ctx].map(b => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = [...ctx].map(b => b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.').join('');
            console.log(`    @${idx}: ${ascii}`);
            console.log(`           ${hex}`);
        }
    }
}

// Detailed hex dump of the full body of class definitions
console.log('\n=== Class/Named block region hex dump ===');
// Look for 'P' markers followed by class names
for (let i = schIdx; i < firstSentinel; i++) {
    if (psBuf[i] === 0x50) { // 'P'
        // Check if this is followed by printable class name-like content
        let lookahead = '';
        for (let j = i + 1; j < Math.min(i + 30, firstSentinel); j++) {
            if (psBuf[j] >= 0x20 && psBuf[j] < 0x7F) {
                lookahead += String.fromCharCode(psBuf[j]);
            } else {
                break;
            }
        }
        if (lookahead.includes('BODY') || lookahead.includes('FACE') || lookahead.includes('COLOUR') ||
            lookahead.includes('ATTRIB') || lookahead.includes('RECIPE') || lookahead.includes('LAST') ||
            lookahead.includes('ENT_') || lookahead.includes('ATOM') || lookahead.includes('SWEnt') ||
            lookahead.includes('LIGHT')) {
            console.log(`  P-block @${i}: P${lookahead}`);
        }
    }
}

// ─── Deep schema parsing: extract class field definitions ────────────────────
// The schema section after SCH_... has numbered field definitions.
// Format appears to be:
// [class#] [parent_class#] ... field definitions ... Z
// Where field definitions use: <name>I (int), <name>d (double), <name>C (class-ref), etc.

console.log('\n=== Deep schema field definitions ===');

// Let's look at schema blocks between Z markers
let blockStart = schIdx + schemaId.length;
let blockNum = 0;
for (const zPos of zPositions) {
    const blockEnd = zPos + schIdx; // zPositions are relative to schIdx
    if (blockNum < 15) {
        const block = schemaRegion.subarray(blockStart - schIdx, zPos + 1);
        const printable = [...block].map(b => {
            if (b >= 0x20 && b < 0x7F) return String.fromCharCode(b);
            if (b === 0x00) return '.';
            if (b === 0x0A) return '\\n';
            if (b === 0x0D) return '\\r';
            return `<${b.toString(16)}>`;
        }).join('');
        const fieldNames = [];
        // Extract field name + type pairs
        const blockBuf = schemaRegion.subarray(blockStart - schIdx, zPos);
        let p = 0;
        while (p < blockBuf.length) {
            // Skip non-printable
            while (p < blockBuf.length && (blockBuf[p] < 0x20 || blockBuf[p] >= 0x7F)) p++;
            if (p >= blockBuf.length) break;
            // Read printable string
            let name = '';
            while (p < blockBuf.length && blockBuf[p] >= 0x20 && blockBuf[p] < 0x7F) {
                name += String.fromCharCode(blockBuf[p]);
                p++;
            }
            if (name.length > 0) {
                // Check if ends with type code
                const lastChar = name[name.length - 1];
                if ('CIdRAJQFD'.includes(lastChar) && name.length > 1) {
                    fieldNames.push({ name: name.slice(0, -1), type: lastChar });
                } else {
                    fieldNames.push({ name, type: '?' });
                }
            }
        }
        
        console.log(`\nBlock ${blockNum} (${blockStart - schIdx}..${zPos}):`);
        if (fieldNames.length > 0) {
            for (const f of fieldNames) {
                console.log(`  ${f.name}: ${f.type}`);
            }
        }
    }
    blockStart = zPos + schIdx + 1;
    blockNum++;
}
console.log(`\nTotal schema blocks: ${blockNum}`);
