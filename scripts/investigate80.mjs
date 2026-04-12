#!/usr/bin/env node
/**
 * investigate80.mjs — Build complete entity map and determine FACE→SURFACE mapping.
 *
 * Uses compact-format entity extraction [00 TYPE ID_hi ID_lo 00 00 FLAGS 00 01]
 * to find ALL entities, then cross-references FACE data fields to find
 * which field position references SURFACE entities.
 *
 * This solves the LINE/PLANE ambiguity: only surfaces referenced by FACEs are
 * real geometric surfaces; others are curves.
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
console.log(`PS buffer: ${ps.length} bytes\n`);

// ─── Extract ALL compact-format entities ─────────────────────────────────────
// Format: [00 TYPE] [ID_hi ID_lo] [00 00] [FLAGS_hi FLAGS_lo] [00 01] [data...]
function extractCompactEntities(buf) {
    const entities = new Map(); // id → {type, pos, dataStart}
    
    for (let i = 0; i < buf.length - 9; i++) {
        if (buf[i] !== 0x00) continue;
        const type = buf[i + 1];
        if (type < 0x0F || type > 0x20) continue;
        
        // Check compact format structure
        if (buf[i + 4] !== 0x00 || buf[i + 5] !== 0x00) continue;
        if (buf[i + 8] !== 0x00 || buf[i + 9] !== 0x01) continue;
        
        const id = buf.readUInt16BE(i + 2);
        if (id === 0 || id > 60000) continue;
        
        const flags = buf.readUInt16BE(i + 6);
        
        entities.set(id, { type, pos: i, dataStart: i + 10, flags });
        // Don't skip by entity size since we don't know it — just advance by 1
    }
    
    return entities;
}

const entities = extractCompactEntities(ps);
console.log(`Total compact-format entities: ${entities.size}`);

// Group by type
const byType = {};
for (const [id, e] of entities) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(id);
}

console.log('Entity types:');
for (const [type, ids] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    const t = parseInt(type);
    const name = { 0x0f: 'FACE', 0x10: 'EDGE', 0x11: 'SHELL', 0x12: 'COEDGE', 0x13: 'LOOP',
                    0x1d: 'POINT', 0x1e: 'CURVE', 0x1f: 'SURFACE', 0x20: 'ATTRIB' }[t] || '??';
    console.log(`  0x${t.toString(16).padStart(2,'0')} (${name}): ${ids.length} entities`);
}

// Build entity ID → type lookup
const idType = new Map();
for (const [id, e] of entities) {
    idType.set(id, e.type);
}

// ─── Analyze FACE entity data cross-references ──────────────────────────────
const faceIds = byType[0x0f] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`FACE field analysis (${faceIds.length} faces)`);
console.log(`${'='.repeat(60)}`);

// For each FACE, read data as uint16 BE pairs and check cross-references
const NUM_FIELDS = 20;
const fieldTypeHits = Array(NUM_FIELDS).fill(null).map(() => ({}));
const fieldValues = Array(NUM_FIELDS).fill(null).map(() => []);

for (const fid of faceIds) {
    const e = entities.get(fid);
    const data = ps.subarray(e.dataStart, Math.min(e.dataStart + NUM_FIELDS * 2, ps.length));
    
    for (let fi = 0; fi < NUM_FIELDS && fi * 2 + 2 <= data.length; fi++) {
        const ref = data.readUInt16BE(fi * 2);
        fieldValues[fi].push(ref);
        
        if (ref > 0 && idType.has(ref)) {
            const refType = idType.get(ref);
            const typeName = { 0x0f: 'FACE', 0x10: 'EDGE', 0x11: 'SHELL', 0x12: 'COEDGE',
                               0x13: 'LOOP', 0x1d: 'POINT', 0x1e: 'CURVE', 0x1f: 'SURFACE',
                               0x20: 'ATTRIB' }[refType] || `0x${refType.toString(16)}`;
            fieldTypeHits[fi][typeName] = (fieldTypeHits[fi][typeName] || 0) + 1;
        } else if (ref === 0) {
            fieldTypeHits[fi]['NULL'] = (fieldTypeHits[fi]['NULL'] || 0) + 1;
        } else if (ref === 1) {
            fieldTypeHits[fi]['ONE'] = (fieldTypeHits[fi]['ONE'] || 0) + 1;
        }
    }
}

console.log('\nField analysis (type of referenced entity):');
for (let fi = 0; fi < NUM_FIELDS; fi++) {
    const hits = fieldTypeHits[fi];
    const total = Object.values(hits).reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    
    // Sort by frequency
    const sorted = Object.entries(hits).sort((a, b) => b[1] - a[1]);
    const summary = sorted.map(([k, v]) => `${k}:${v}`).join(', ');
    
    // Stats for the field values
    const vals = fieldValues[fi];
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    
    console.log(`  Field[${fi}] (bytes ${fi*2}-${fi*2+1}): ${summary} | range: ${min}-${max}`);
}

// ─── Extract FACE → SURFACE mapping ──────────────────────────────────────────
// From the field analysis, find which field consistently points to SURFACE/CURVE
// Then extract the mapping

// Let me also check: does the FACE "flags" field correlate with anything?
console.log('\n=== FACE → neighboring entities (first 20) ===');
for (const fid of faceIds.slice(0, 20)) {
    const e = entities.get(fid);
    const data = ps.subarray(e.dataStart, Math.min(e.dataStart + 40, ps.length));
    
    const fields = [];
    for (let fi = 0; fi < 20 && fi * 2 + 2 <= data.length; fi++) {
        const ref = data.readUInt16BE(fi * 2);
        const refType = idType.get(ref);
        const typeName = refType ? { 0x0f: 'F', 0x10: 'E', 0x11: 'S', 0x12: 'C', 0x13: 'L',
                                      0x1d: 'P', 0x1e: 'Cv', 0x1f: 'Sf', 0x20: 'A' }[refType] || '?' : '';
        fields.push(typeName ? `${ref}(${typeName})` : `${ref}`);
    }
    
    // Also check: is the FACE "flags" field (from the header) a meaningful reference?
    const flagsType = idType.get(e.flags);
    const flagsName = flagsType ? { 0x0f: 'FACE', 0x10: 'EDGE', 0x12: 'COEDGE', 0x1e: 'CURVE',
                                     0x1f: 'SURFACE' }[flagsType] || `0x${flagsType.toString(16)}` : '';
    
    console.log(`  FACE #${fid} (flags=${e.flags}${flagsName ? '→' + flagsName : ''}): [${fields.join(', ')}]`);
}

// ─── Check if FACE.flags is actually the SURFACE reference ──────────────────
console.log('\n=== FACE flags → entity type distribution ===');
const flagsTypeHits = {};
for (const fid of faceIds) {
    const e = entities.get(fid);
    if (idType.has(e.flags)) {
        const refType = idType.get(e.flags);
        const typeName = { 0x0f: 'FACE', 0x10: 'EDGE', 0x11: 'SHELL', 0x12: 'COEDGE',
                           0x1d: 'POINT', 0x1e: 'CURVE', 0x1f: 'SURFACE', 0x20: 'ATTRIB' }[refType] || `0x${refType.toString(16)}`;
        flagsTypeHits[typeName] = (flagsTypeHits[typeName] || 0) + 1;
    } else {
        flagsTypeHits['UNKNOWN'] = (flagsTypeHits['UNKNOWN'] || 0) + 1;
    }
}
console.log(JSON.stringify(flagsTypeHits));

// ─── Build FACE → SURFACE/CURVE map from the identified field ────────────────
// After analyzing the field distributions, find which fields (data or flags)
// point to SURFACE or CURVE entities
console.log('\n=== FACE → geometry entity mapping ===');

let surfaceField = -1; // Which data field is the surface reference?
let curveFieldHits = {};
let surfFieldHits = {};

for (let fi = 0; fi < NUM_FIELDS; fi++) {
    const hits = fieldTypeHits[fi];
    if (hits['SURFACE'] || hits['CURVE']) {
        const surfCount = (hits['SURFACE'] || 0) + (hits['CURVE'] || 0);
        console.log(`  Field[${fi}]: ${surfCount} geometry refs (SURFACE:${hits['SURFACE']||0}, CURVE:${hits['CURVE']||0})`);
    }
}

// Check flags separately
let flagsSurf = 0, flagsCurve = 0;
for (const fid of faceIds) {
    const e = entities.get(fid);
    if (idType.has(e.flags)) {
        const refType = idType.get(e.flags);
        if (refType === 0x1f) flagsSurf++;
        if (refType === 0x1e) flagsCurve++;
    }
}
console.log(`  FLAGS: ${flagsSurf} SURFACE refs, ${flagsCurve} CURVE refs, total=${flagsSurf + flagsCurve}`);

// ─── Comprehensive FACE → SURFACE statistics ────────────────────────────────
// Each FACE should reference exactly ONE surface. The field that has surface refs
// for the most faces is the surface field.
console.log('\n=== FACE → SURFACE completeness check ===');

// Try all possible fields
for (const fieldSrc of ['flags', 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    let surfHits = 0;
    let curveHits = 0;
    const surfaceIds = new Set();
    
    for (const fid of faceIds) {
        const e = entities.get(fid);
        let refId;
        if (fieldSrc === 'flags') {
            refId = e.flags;
        } else {
            const data = ps.subarray(e.dataStart, e.dataStart + 30);
            if (fieldSrc * 2 + 2 > data.length) continue;
            refId = data.readUInt16BE(fieldSrc * 2);
        }
        
        const refType = idType.get(refId);
        if (refType === 0x1f) { surfHits++; surfaceIds.add(refId); }
        if (refType === 0x1e) { curveHits++; surfaceIds.add(refId); }
    }
    
    if (surfHits + curveHits > 10) {
        console.log(`  ${fieldSrc === 'flags' ? 'flags' : 'field[' + fieldSrc + ']'}: ` +
            `SURFACE=${surfHits}, CURVE=${curveHits}, ` +
            `unique_surfaces=${surfaceIds.size}, ` +
            `coverage=${((surfHits + curveHits) / faceIds.length * 100).toFixed(1)}%`);
    }
}
