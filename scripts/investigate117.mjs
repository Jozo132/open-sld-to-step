#!/usr/bin/env node
/**
 * investigate117.mjs — Raw loop/face sub-record survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Extract type-0x13 LOOP and type-0x0F FACE entities from sentinel blocks.
 * 2. Summarize payload lengths and aligned uint16 refs.
 * 3. Correlate aligned refs with coedge, loop, face, shell, and geometry ids.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const TYPE_FACE = 0x0f;
const TYPE_SHELL = 0x11;
const TYPE_LOOP = 0x13;

function findSldprtFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findSldprtFiles(fullPath));
        else if (/\.sldprt$/i.test(entry.name)) results.push(fullPath);
    }
    return results;
}

function toHex(bytes) {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
}

function extractAllEntities(buf) {
    const entities = [];
    const sentPositions = [];
    let idx = 0;
    while ((idx = buf.indexOf(SENTINEL, idx)) >= 0) {
        sentPositions.push(idx);
        idx += SENTINEL.length;
    }

    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + SENTINEL.length;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : buf.length;
        const block = buf.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        const subRecords = [];
        let searchStart = 0;
        while (true) {
            const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
            if (sepIdx < 0) {
                subRecords.push({ data: block.subarray(searchStart), offset: blockStart + searchStart, primary: subRecords.length === 0 });
                break;
            }
            subRecords.push({ data: block.subarray(searchStart, sepIdx), offset: blockStart + searchStart, primary: subRecords.length === 0 });
            searchStart = sepIdx + SUB_RECORD_SEP.length;
        }

        for (const sub of subRecords) {
            const rec = sub.data;
            if (sub.primary) {
                if (rec.length < 8) continue;
                if (rec.readUInt32BE(0) !== 3) continue;
                const type = rec[5];
                if (type < 0x0d || type > 0x3f) continue;
                entities.push({ type, id: rec.readUInt16BE(6), data: rec.subarray(8), offset: sub.offset, primary: true });
            } else {
                if (rec.length < 4 || rec[0] !== 0x00) continue;
                const type = rec[1];
                if (type < 0x0d || type > 0x3f) continue;
                entities.push({ type, id: rec.readUInt16BE(2), data: rec.subarray(4), offset: sub.offset, primary: false });
            }
        }
    }

    return entities;
}

function countBy(items, keyFn) {
    const counts = new Map();
    for (const item of items) {
        const key = keyFn(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function summarizeAlignedRefs(records, lookupSets, maxWords = 10) {
    const summary = [];
    for (let wordIndex = 0; wordIndex < maxWords; wordIndex++) {
        const byteOffset = wordIndex * 2;
        const counts = {};
        for (const record of records) {
            if (byteOffset + 2 > record.data.length) continue;
            const ref = record.data.readUInt16BE(byteOffset);
            for (const [name, ids] of lookupSets) {
                if (ids.has(ref)) counts[name] = (counts[name] ?? 0) + 1;
            }
        }
        summary.push([byteOffset, counts]);
    }
    return summary;
}

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== RAW LOOP/FACE SUB-RECORD SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const entities = extractAllEntities(extracted.data);
    const loops = entities.filter(entity => entity.type === TYPE_LOOP);
    const faces = entities.filter(entity => entity.type === TYPE_FACE);
    const shells = entities.filter(entity => entity.type === TYPE_SHELL);
    const coedges = parser.parseCoedgeRecords();
    const edges = parser.parseEdgeRecords();
    const geometry = parser.parseAllGeometryLikeRecords();

    console.log(`\n${fileName}`);
    console.log(`  loops=${loops.length} faces=${faces.length} shells=${shells.length}`);
    console.log(`  loopLengths=${JSON.stringify(Object.fromEntries(countBy(loops, record => record.data.length).slice(0, 6)))}`);
    console.log(`  faceLengths=${JSON.stringify(Object.fromEntries(countBy(faces, record => record.data.length).slice(0, 6)))}`);

    const lookupSets = [
        ['coedge', new Set(coedges.map(record => record.id))],
        ['edge', new Set(edges.map(record => record.id))],
        ['geometry', new Set(geometry.map(record => record.id))],
        ['loop', new Set(loops.map(record => record.id))],
        ['face', new Set(faces.map(record => record.id))],
        ['shell', new Set(shells.map(record => record.id))],
    ];

    for (const [offset, counts] of summarizeAlignedRefs(loops, lookupSets)) {
        console.log(`  loopWord@${offset}=${JSON.stringify(counts)}`);
    }
    for (const [offset, counts] of summarizeAlignedRefs(faces, lookupSets)) {
        console.log(`  faceWord@${offset}=${JSON.stringify(counts)}`);
    }

    for (const record of loops.slice(0, 3)) {
        const words = [];
        for (let offset = 0; offset + 2 <= Math.min(record.data.length, 20); offset += 2) {
            words.push(record.data.readUInt16BE(offset));
        }
        console.log(`  loop id=${record.id} primary=${record.primary} len=${record.data.length} words=[${words.join(', ')}]`);
        console.log(`    hex=${toHex(record.data.subarray(0, Math.min(record.data.length, 24)))}`);
    }
    for (const record of faces.slice(0, 3)) {
        const words = [];
        for (let offset = 0; offset + 2 <= Math.min(record.data.length, 20); offset += 2) {
            words.push(record.data.readUInt16BE(offset));
        }
        console.log(`  face id=${record.id} primary=${record.primary} len=${record.data.length} words=[${words.join(', ')}]`);
        console.log(`    hex=${toHex(record.data.subarray(0, Math.min(record.data.length, 24)))}`);
    }
}