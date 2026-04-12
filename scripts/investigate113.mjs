#!/usr/bin/env node
/**
 * investigate113.mjs — Residual geometry-like header survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Classify geometryLikeId values still unresolved after compact+packed parsing.
 * 2. Determine whether the FTC_07 residual branch is a stable compact family.
 * 3. Print representative headers so the next decoder change can stay minimal.
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

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

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

function findHeadersById(buf, targetId) {
    const hits = [];

    for (let offset = 0; offset + 20 <= buf.length; offset++) {
        if (buf[offset] !== 0x00) continue;
        const type = buf[offset + 1];
        if (type < 0x0f || type > 0x90) continue;

        if (
            buf[offset + 2] !== 0xff
            && buf.readUInt16BE(offset + 2) === targetId
            && buf[offset + 4] === 0x00
            && buf[offset + 5] === 0x00
            && buf[offset + 8] === 0x00
            && buf[offset + 9] === 0x01
        ) {
            hits.push({
                format: 'compact',
                offset,
                type,
                id: targetId,
                flags: buf.readUInt16BE(offset + 6),
                trailer: null,
                refIds: [
                    buf.readUInt16BE(offset + 10),
                    buf.readUInt16BE(offset + 12),
                    buf.readUInt16BE(offset + 14),
                    buf.readUInt16BE(offset + 16),
                ],
                marker18: buf[offset + 18],
                marker19: buf[offset + 19],
                bytes: toHex(buf.subarray(offset, offset + 24)),
            });
        }

        if (
            buf[offset + 2] === 0xff
            && buf.readUInt16BE(offset + 3) === targetId
            && buf[offset + 5] === 0x00
            && buf[offset + 6] === 0x00
        ) {
            hits.push({
                format: 'packed',
                offset,
                type,
                id: targetId,
                flags: buf.readUInt16BE(offset + 7),
                trailer: buf.readUInt16BE(offset + 9),
                refIds: [
                    buf.readUInt16BE(offset + 11),
                    buf.readUInt16BE(offset + 13),
                    buf.readUInt16BE(offset + 15),
                    buf.readUInt16BE(offset + 17),
                ],
                marker18: buf[offset + 18],
                marker19: buf[offset + 19],
                bytes: toHex(buf.subarray(offset, offset + 24)),
            });
        }
    }

    return hits;
}

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== RESIDUAL GEOMETRY-LIKE SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const known = new Set(parser.parseAllGeometryLikeRecords().map(record => record.id));
    const unresolved = [...new Set(parser.parseEdgeRecords().map(edge => edge.geometryLikeId).filter(id => !known.has(id)))];

    console.log(`\n${fileName}`);
    console.log(`  unresolved=[${unresolved.join(', ')}]`);
    if (unresolved.length === 0) continue;

    const byType = new Map();
    for (const id of unresolved) {
        const hits = findHeadersById(extracted.data, id);
        for (const hit of hits) {
            const key = `${hit.format}:${hit.type}`;
            byType.set(key, (byType.get(key) ?? 0) + 1);
        }
    }
    console.log(`  headerTypes=${JSON.stringify(Object.fromEntries([...byType.entries()].sort()))}`);

    for (const id of unresolved.slice(0, 8)) {
        const hits = findHeadersById(extracted.data, id);
        console.log(`  id=${id} hits=${hits.length}`);
        for (const hit of hits.slice(0, 3)) {
            console.log(
                `    ${hit.format} type=${hit.type} offset=${hit.offset} flags=${hit.flags} trailer=${hit.trailer ?? '-'} refs=[${hit.refIds.join(', ')}] marker18=0x${hit.marker18.toString(16)} marker19=0x${hit.marker19.toString(16)}`,
            );
            console.log(`    bytes=${hit.bytes}`);
        }
    }
}