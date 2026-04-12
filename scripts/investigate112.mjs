#!/usr/bin/env node
/**
 * investigate112.mjs — Packed geometry-like survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Decode packed FF-format geometry-like records with four refs and marker at offset 19.
 * 2. Measure the improvement when they are merged with the compact geometry-like index.
 * 3. Leave the remaining small unresolved set isolated for the next pass.
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

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== PACKED GEOMETRY-LIKE SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const edges = parser.parseEdgeRecords();
    const compact = new Set(parser.parseCompactGeometryLikeRecords().map(record => record.id));
    const packed = parser.parsePackedGeometryLikeRecords();
    const combined = new Set(parser.parseAllGeometryLikeRecords().map(record => record.id));
    const compactResolved = edges.filter(edge => compact.has(edge.geometryLikeId)).length;
    const combinedResolved = edges.filter(edge => combined.has(edge.geometryLikeId)).length;
    const unresolved = [...new Set(edges.map(edge => edge.geometryLikeId).filter(id => !combined.has(id)))];

    console.log(`\n${fileName}`);
    console.log(`  packed=${packed.length} compactResolved=${compactResolved}/${edges.length} combinedResolved=${combinedResolved}/${edges.length}`);
    console.log(`  unresolved=[${unresolved.slice(0, 20).join(', ')}]`);
    for (const record of packed.slice(0, 6)) {
        console.log(
            `  id=${record.id} type=${record.type} refs=[${record.refIds.join(', ')}] marker=0x${record.markerByte.toString(16)}`,
        );
    }
}