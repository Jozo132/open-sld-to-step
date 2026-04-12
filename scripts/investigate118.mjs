#!/usr/bin/env node
/**
 * investigate118.mjs — Face payload topology-hit survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Search aligned uint16 words inside raw face payloads.
 * 2. Measure where those words coincide with known coedge, edge, face, and shell ids.
 * 3. Determine whether face payloads likely inline boundary carriers.
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

function extractEntities(buf) {
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
                if (rec.length < 8 || rec.readUInt32BE(0) !== 3) continue;
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

function countHits(records, idSet, startWord = 0, maxWord = 40) {
    const counts = new Map();
    for (let wordIndex = startWord; wordIndex < maxWord; wordIndex++) {
        const byteOffset = wordIndex * 2;
        let hits = 0;
        for (const record of records) {
            if (byteOffset + 2 > record.data.length) continue;
            const word = record.data.readUInt16BE(byteOffset);
            if (word <= 1) continue;
            if (idSet.has(word)) hits++;
        }
        if (hits > 0) counts.set(byteOffset, hits);
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]);
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

console.log('=== FACE PAYLOAD TOPOLOGY HIT SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const entities = extractEntities(extracted.data);
    const faces = entities.filter(entity => entity.type === TYPE_FACE);
    const shells = entities.filter(entity => entity.type === TYPE_SHELL);
    if (faces.length === 0) continue;

    const coedgeIds = new Set(parser.parseCoedgeRecords().map(record => record.id));
    const edgeIds = new Set(parser.parseEdgeRecords().map(record => record.id));
    const faceIds = new Set(faces.map(record => record.id));
    const shellIds = new Set(shells.map(record => record.id));

    console.log(`\n${fileName}`);
    console.log(`  faces=${faces.length}`);
    console.log(`  coedgeHits=${JSON.stringify(countHits(faces, coedgeIds))}`);
    console.log(`  edgeHits=${JSON.stringify(countHits(faces, edgeIds))}`);
    console.log(`  faceHits=${JSON.stringify(countHits(faces, faceIds))}`);
    console.log(`  shellHits=${JSON.stringify(countHits(faces, shellIds))}`);

    for (const record of faces.slice(0, 3)) {
        const notable = [];
        for (let wordIndex = 0; wordIndex < Math.min(40, Math.floor(record.data.length / 2)); wordIndex++) {
            const byteOffset = wordIndex * 2;
            const word = record.data.readUInt16BE(byteOffset);
            if (word <= 1) continue;
            const tags = [];
            if (coedgeIds.has(word)) tags.push('coedge');
            if (edgeIds.has(word)) tags.push('edge');
            if (faceIds.has(word)) tags.push('face');
            if (shellIds.has(word)) tags.push('shell');
            if (tags.length > 0) notable.push({ byteOffset, word, tags: tags.join('+') });
        }
        console.log(`  face ${record.id} notable=${JSON.stringify(notable.slice(0, 16))}`);
    }
}