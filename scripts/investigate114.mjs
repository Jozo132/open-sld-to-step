#!/usr/bin/env node
/**
 * investigate114.mjs — No-header geometryLikeId residue survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Trace the five remaining unresolved geometryLikeId values back to their edge records.
 * 2. Search for weaker compactish/packedish header candidates for those ids.
 * 3. Leave a concrete byte-level starting point for the next decoder pass.
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

function findWeakCandidates(buf, targetId) {
    const candidates = [];

    for (let offset = 0; offset + 24 <= buf.length; offset++) {
        if (buf[offset] !== 0x00) continue;
        const type = buf[offset + 1];
        if (type < 0x0f || type > 0x90) continue;

        if (buf.readUInt16BE(offset + 2) === targetId) {
            candidates.push({
                kind: 'compactish',
                offset,
                type,
                flags: buf.readUInt16BE(offset + 6),
                marker18: buf[offset + 18],
                marker19: buf[offset + 19],
                bytes: toHex(buf.subarray(offset, offset + 24)),
            });
        }

        if (buf[offset + 2] === 0xff && buf.readUInt16BE(offset + 3) === targetId) {
            candidates.push({
                kind: 'packedish',
                offset,
                type,
                flags: buf.readUInt16BE(offset + 7),
                marker18: buf[offset + 18],
                marker19: buf[offset + 19],
                bytes: toHex(buf.subarray(offset, offset + 24)),
            });
        }
    }

    return candidates;
}

function findRawOccurrences(buf, targetId) {
    const needle = Buffer.allocUnsafe(2);
    needle.writeUInt16BE(targetId, 0);
    const occurrences = [];
    let offset = 0;

    while ((offset = buf.indexOf(needle, offset)) >= 0) {
        const start = Math.max(0, offset - 8);
        const end = Math.min(buf.length, offset + 16);
        occurrences.push({
            offset,
            aligned16: offset % 2 === 0,
            context: toHex(buf.subarray(start, end)),
        });
        offset += 1;
    }

    return occurrences;
}

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== NO-HEADER GEOMETRY RESIDUE ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const geometry = new Set(parser.parseAllGeometryLikeRecords().map(record => record.id));
    const edges = parser.parseEdgeRecords();
    const unresolved = [...new Set(edges.map(edge => edge.geometryLikeId).filter(id => !geometry.has(id)))];
    if (unresolved.length === 0) continue;

    console.log(`\n${fileName}`);
    for (const id of unresolved) {
        console.log(`  geometryLikeId=${id}`);

        const linkedEdges = edges.filter(edge => edge.geometryLikeId === id);
        for (const edge of linkedEdges) {
            console.log(
                `    edge=${edge.id} first=${edge.firstRefId} prev=${edge.prevEdgeId} next=${edge.nextEdgeId} geom=${edge.geometryLikeId} tail=[${edge.trailingRefAId}, ${edge.trailingRefBId}]`,
            );
        }

        const candidates = findWeakCandidates(extracted.data, id);
        console.log(`    weakCandidates=${candidates.length}`);
        for (const candidate of candidates.slice(0, 6)) {
            console.log(
                `      ${candidate.kind} type=${candidate.type} offset=${candidate.offset} flags=${candidate.flags} marker18=0x${candidate.marker18.toString(16)} marker19=0x${candidate.marker19.toString(16)}`,
            );
            console.log(`      bytes=${candidate.bytes}`);
        }

        const occurrences = findRawOccurrences(extracted.data, id);
        console.log(`    rawOccurrences=${occurrences.length}`);
        for (const occurrence of occurrences.slice(0, 8)) {
            console.log(
                `      offset=${occurrence.offset} aligned16=${occurrence.aligned16} context=${occurrence.context}`,
            );
        }
    }
}