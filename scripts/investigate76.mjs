#!/usr/bin/env node
/**
 * investigate76.mjs — Analyze entity cross-references for topology chains.
 * 
 * Goal: For each type-15/0x0F entity (FACE), find references to
 * surface/loop entities. This gives us FACE→SURFACE mapping needed
 * for proper topology extraction.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const FILE = `${NIST_DIR}/nist_ctc_01_asme1_rd_sw1802.SLDPRT`;

const buf = readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
const psBuf = result?.data;

if (!psBuf) { console.log('No PS data'); process.exit(1); }
console.log(`PS buffer: ${psBuf.length} bytes`);

// ─── Find sentinel positions ─────────────────────────────────────────────────
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

function findAll(buf, pattern) {
    const positions = [];
    let start = 0;
    while (true) {
        const idx = buf.indexOf(pattern, start);
        if (idx < 0) break;
        positions.push(idx);
        start = idx + 1;
    }
    return positions;
}

const sentinels = findAll(psBuf, SENTINEL);

// ─── Extract all entities ────────────────────────────────────────────────────
const entities = new Map(); // id → {type, data, offset}

for (let si = 0; si < sentinels.length; si++) {
    const sentPos = sentinels[si];
    const nextSent = si + 1 < sentinels.length ? sentinels[si + 1] : psBuf.length;
    
    // Primary entity: [00 00 00 03] [00 TYPE] [ID_hi ID_lo] before sentinel
    if (sentPos >= 8) {
        const h = sentPos - 8;
        if (psBuf[h] === 0x00 && psBuf[h+1] === 0x00 && psBuf[h+2] === 0x00 && psBuf[h+3] === 0x03) {
            const type = psBuf[h + 5];
            const id = psBuf.readUInt16BE(h + 6);
            const dataStart = sentPos + 6;
            entities.set(id, { type, data: psBuf.subarray(dataStart, nextSent), offset: h });
        }
    }
    
    // Sub-records
    const blockData = psBuf.subarray(sentPos + 6, nextSent);
    const subSeps = findAll(blockData, SUB_SEP);
    
    for (let ssIdx = 0; ssIdx < subSeps.length; ssIdx++) {
        const sepOff = subSeps[ssIdx];
        const subStart = sepOff + SUB_SEP.length;
        if (subStart + 4 > blockData.length) continue;
        
        const type = blockData[subStart + 1];
        const id = blockData.readUInt16BE(subStart + 2);
        
        let subEnd = blockData.length;
        for (let nsi = ssIdx + 1; nsi < subSeps.length; nsi++) {
            subEnd = subSeps[nsi]; break;
        }
        
        entities.set(id, { type, data: blockData.subarray(subStart + 4, subEnd), offset: sentPos + 6 + subStart });
    }
}

console.log(`Extracted ${entities.size} unique entities`);

// ─── Build entity type index ─────────────────────────────────────────────
const byType = {};
for (const [id, e] of entities) {
    const t = e.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push(id);
}

console.log('\nEntity types:');
for (const [type, ids] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  0x${parseInt(type).toString(16).padStart(2, '0')}: ${ids.length} entities (IDs: ${ids.slice(0, 5).join(',')}${ids.length > 5 ? '...' : ''})`);
}

// ─── Analyze type-0x0F (type decimal 15 = FACE) entities ─────────────────────
const faceIds = byType[0x0F] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`TYPE 0x0F (FACE): ${faceIds.length} entities`);
console.log(`${'='.repeat(60)}`);

// For each FACE, read its first 20 bytes as int16 refs and check if any point
// to known entity IDs of specific types
const surfIds = new Set(byType[0x1E] || []);
const bspIds = new Set(byType[0x1F] || []);
const loopIds = new Set(byType[0x13] || []);
const edgeIds = new Set(byType[0x10] || []);

const allRefFields = [];

for (const fid of faceIds.slice(0, 20)) {
    const e = entities.get(fid);
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(e.data.length, 30); off += 2) {
        refs.push(e.data.readUInt16BE(off));
    }
    
    const refTypes = refs.map(r => {
        if (surfIds.has(r)) return `${r}(0x1E)`;
        if (bspIds.has(r)) return `${r}(0x1F)`;
        if (loopIds.has(r)) return `${r}(0x13)`;
        if (edgeIds.has(r)) return `${r}(0x10)`;
        if (entities.has(r)) return `${r}(0x${entities.get(r).type.toString(16)})`;
        return `${r}`;
    });
    
    console.log(`\n Face ${fid}: refs = [${refTypes.join(', ')}]`);
    console.log(`   hex(20): ${Buffer.from(e.data.subarray(0, Math.min(20, e.data.length))).toString('hex').match(/.{1,2}/g).join(' ')}`);
    
    allRefFields.push(refs);
}

// ─── Analyze common patterns in FACE ref fields ─────────────────────────────
console.log('\n--- FACE reference field patterns ---');
if (allRefFields.length > 3) {
    for (let fieldIdx = 0; fieldIdx < 8; fieldIdx++) {
        const values = allRefFields.map(r => r[fieldIdx]).filter(v => v !== undefined);
        if (values.length === 0) continue;
        
        // Check what entity types these refs point to
        const typeHits = {};
        for (const v of values) {
            const e = entities.get(v);
            if (e) {
                const key = `0x${e.type.toString(16)}`;
                typeHits[key] = (typeHits[key] || 0) + 1;
            }
        }
        console.log(`  Field[${fieldIdx}]: ${values.length} values, type hits: ${JSON.stringify(typeHits)}`);
    }
}

// ─── Analyze type-0x10 (EDGE) entities ──────────────────────────────────────
const edgeIdsList = byType[0x10] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`TYPE 0x10 (EDGE): ${edgeIdsList.length} entities`);
console.log(`${'='.repeat(60)}`);

for (const eid of edgeIdsList.slice(0, 10)) {
    const e = entities.get(eid);
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(e.data.length, 24); off += 2) {
        refs.push(e.data.readUInt16BE(off));
    }
    
    const refTypes = refs.map(r => {
        if (surfIds.has(r)) return `${r}(0x1E)`;
        if (bspIds.has(r)) return `${r}(0x1F)`;
        if (loopIds.has(r)) return `${r}(0x13)`;
        if (edgeIds.has(r)) return `${r}(0x10)`;
        if (entities.has(r)) return `${r}(0x${entities.get(r).type.toString(16)})`;
        return `${r}`;
    });
    
    console.log(` Edge ${eid}: refs = [${refTypes.join(', ')}]`);
}

// ─── Type-0x12 (COEDGE) ─────────────────────────────────────────────────────
const coedgeIds = byType[0x12] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`TYPE 0x12 (COEDGE): ${coedgeIds.length} entities`);
console.log(`${'='.repeat(60)}`);

for (const cid of coedgeIds.slice(0, 10)) {
    const e = entities.get(cid);
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(e.data.length, 20); off += 2) {
        refs.push(e.data.readUInt16BE(off));
    }
    
    const refTypes = refs.map(r => {
        if (entities.has(r)) return `${r}(0x${entities.get(r).type.toString(16)})`;
        return `${r}`;
    });
    
    console.log(` Coedge ${cid}: refs = [${refTypes.join(', ')}]`);
}

// ─── Type-0x13 (LOOP) ──────────────────────────────────────────────────────
const loopIdsList = byType[0x13] || [];
console.log(`\n${'='.repeat(60)}`);
console.log(`TYPE 0x13 (LOOP): ${loopIdsList.length} entities`);
console.log(`${'='.repeat(60)}`);

for (const lid of loopIdsList.slice(0, 10)) {
    const e = entities.get(lid);
    const refs = [];
    for (let off = 0; off + 2 <= Math.min(e.data.length, 20); off += 2) {
        refs.push(e.data.readUInt16BE(off));
    }
    
    const refTypes = refs.map(r => {
        if (entities.has(r)) return `${r}(0x${entities.get(r).type.toString(16)})`;
        return `${r}`;
    });
    
    console.log(` Loop ${lid}: refs = [${refTypes.join(', ')}]`);
}
