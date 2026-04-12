#!/usr/bin/env node
/**
 * investigate116.mjs — Loop/face sentinel layout survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Determine whether type-0x13 LOOP and type-0x0F FACE records use the
 *    compact-terminator form, the compact-after-sentinel form, or a packed form.
 * 2. Correlate their refs with known coedge, edge, geometry-like, and sibling ids.
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

const SENTINEL_8 = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);
const TYPE_FACE = 0x0f;
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

function findSentinels(buf) {
    const offsets = [];
    let offset = 0;
    while ((offset = buf.indexOf(SENTINEL_8, offset)) >= 0) {
        offsets.push(offset);
        offset += SENTINEL_8.length;
    }
    return offsets;
}

function isCompactHeader(buf, offset, end) {
    if (offset < 0 || offset + 10 > end) return false;
    if (buf[offset] !== 0x00) return false;
    const type = buf[offset + 1];
    if (type < 0x0f || type > 0x90) return false;
    const id = buf.readUInt16BE(offset + 2);
    if (id === 0 || id > 10000) return false;
    if (buf[offset + 4] !== 0x00 || buf[offset + 5] !== 0x00) return false;
    return buf[offset + 8] === 0x00 && buf[offset + 9] === 0x01;
}

function isPackedHeader(buf, offset, end) {
    if (offset < 0 || offset + 11 > end) return false;
    if (buf[offset] !== 0x00 || buf[offset + 2] !== 0xff) return false;
    const type = buf[offset + 1];
    if (type < 0x0f || type > 0x90) return false;
    const id = buf.readUInt16BE(offset + 3);
    if (id === 0 || id > 10000) return false;
    if (buf[offset + 5] !== 0x00 || buf[offset + 6] !== 0x00) return false;
    const trailer = buf.readUInt16BE(offset + 9);
    return trailer > 0 && trailer <= 0x0400;
}

function collectCandidateRecords(buf, sentinels, type) {
    const records = [];

    for (const sentinelOffset of sentinels) {
        const termOffset = sentinelOffset - 18;
        if (isCompactHeader(buf, termOffset, sentinelOffset) && buf[termOffset + 1] === type) {
            records.push({
                form: 'terminator',
                sentinelOffset,
                offset: termOffset,
                type,
                id: buf.readUInt16BE(termOffset + 2),
                flags: buf.readUInt16BE(termOffset + 6),
                refs: [
                    buf.readUInt16BE(termOffset + 10),
                    buf.readUInt16BE(termOffset + 12),
                    buf.readUInt16BE(termOffset + 14),
                    buf.readUInt16BE(termOffset + 16),
                ],
            });
        }

        const payloadOffset = sentinelOffset - 10;
        if (isCompactHeader(buf, payloadOffset, sentinelOffset) && buf[payloadOffset + 1] === type) {
            const refsStart = sentinelOffset + SENTINEL_8.length;
            if (refsStart + 12 <= buf.length) {
                records.push({
                    form: 'after-sentinel-compact',
                    sentinelOffset,
                    offset: payloadOffset,
                    type,
                    id: buf.readUInt16BE(payloadOffset + 2),
                    flags: buf.readUInt16BE(payloadOffset + 6),
                    refs: [
                        buf.readUInt16BE(refsStart),
                        buf.readUInt16BE(refsStart + 2),
                        buf.readUInt16BE(refsStart + 4),
                        buf.readUInt16BE(refsStart + 6),
                        buf.readUInt16BE(refsStart + 8),
                        buf.readUInt16BE(refsStart + 10),
                    ],
                });
            }
        }

        const packedOffset = sentinelOffset - 11;
        if (isPackedHeader(buf, packedOffset, sentinelOffset) && buf[packedOffset + 1] === type) {
            const refsStart = sentinelOffset + SENTINEL_8.length;
            if (refsStart + 12 <= buf.length) {
                records.push({
                    form: 'after-sentinel-packed',
                    sentinelOffset,
                    offset: packedOffset,
                    type,
                    id: buf.readUInt16BE(packedOffset + 3),
                    flags: buf.readUInt16BE(packedOffset + 7),
                    trailer: buf.readUInt16BE(packedOffset + 9),
                    refs: [
                        buf.readUInt16BE(refsStart),
                        buf.readUInt16BE(refsStart + 2),
                        buf.readUInt16BE(refsStart + 4),
                        buf.readUInt16BE(refsStart + 6),
                        buf.readUInt16BE(refsStart + 8),
                        buf.readUInt16BE(refsStart + 10),
                    ],
                });
            }
        }
    }

    return records;
}

function summarizeRefs(records, lookupSets) {
    const summary = [];
    const width = Math.max(...records.map(record => record.refs.length), 0);
    for (let index = 0; index < width; index++) {
        const counts = {};
        for (const record of records) {
            const ref = record.refs[index];
            if (ref === undefined) continue;
            for (const [name, ids] of lookupSets) {
                if (ids.has(ref)) counts[name] = (counts[name] ?? 0) + 1;
            }
        }
        summary.push([index, counts]);
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

console.log('=== LOOP/FACE SENTINEL SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const sentinels = findSentinels(extracted.data);
    const coedges = parser.parseCoedgeRecords();
    const edges = parser.parseEdgeRecords();
    const geometry = parser.parseAllGeometryLikeRecords();

    const coedgeIds = new Set(coedges.map(record => record.id));
    const edgeIds = new Set(edges.map(record => record.id));
    const geometryIds = new Set(geometry.map(record => record.id));

    const loopRecords = collectCandidateRecords(extracted.data, sentinels, TYPE_LOOP);
    const faceRecords = collectCandidateRecords(extracted.data, sentinels, TYPE_FACE);

    console.log(`\n${fileName}`);
    console.log(`  loops=${loopRecords.length} faces=${faceRecords.length}`);

    const loopForms = Object.groupBy(loopRecords, record => record.form);
    const faceForms = Object.groupBy(faceRecords, record => record.form);
    console.log(`  loopForms=${JSON.stringify(Object.fromEntries(Object.entries(loopForms).map(([k, v]) => [k, v.length])))}`);
    console.log(`  faceForms=${JSON.stringify(Object.fromEntries(Object.entries(faceForms).map(([k, v]) => [k, v.length])))}`);

    const loopLookups = [
        ['coedge', coedgeIds],
        ['edge', edgeIds],
        ['geometry', geometryIds],
        ['loop', new Set(loopRecords.map(record => record.id))],
        ['face', new Set(faceRecords.map(record => record.id))],
    ];
    const faceLookups = [
        ['coedge', coedgeIds],
        ['edge', edgeIds],
        ['geometry', geometryIds],
        ['loop', new Set(loopRecords.map(record => record.id))],
        ['face', new Set(faceRecords.map(record => record.id))],
    ];

    for (const [index, counts] of summarizeRefs(loopRecords, loopLookups).slice(0, 6)) {
        console.log(`  loopRef[${index}]=${JSON.stringify(counts)}`);
    }
    for (const [index, counts] of summarizeRefs(faceRecords, faceLookups).slice(0, 6)) {
        console.log(`  faceRef[${index}]=${JSON.stringify(counts)}`);
    }

    for (const record of loopRecords.slice(0, 3)) {
        console.log(`  loop ${record.form} id=${record.id} flags=${record.flags} refs=[${record.refs.join(', ')}]`);
    }
    for (const record of faceRecords.slice(0, 3)) {
        console.log(`  face ${record.form} id=${record.id} flags=${record.flags} refs=[${record.refs.join(', ')}]`);
    }
}