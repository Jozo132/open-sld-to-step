#!/usr/bin/env node
/**
 * investigate110.mjs — Compact geometry index survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Decode the dominant compact type-30/type-31 layout with four leading refs.
 * 2. Measure how many type-16 geometryLikeId values resolve into that index.
 * 3. Establish a stable baseline before parsing the anomalous compact geometry variants.
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

console.log('=== COMPACT GEOMETRY INDEX SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const edges = parser.parseEdgeRecords();
    const geometry = parser.parseCompactGeometryRecords();
    const geometryById = new Map(geometry.map(record => [record.id, record]));
    const resolved = edges.filter(edge => geometryById.has(edge.geometryLikeId));

    console.log(`\n${fileName}`);
    console.log(`  geometry=${geometry.length} resolvedEdges=${resolved.length}/${edges.length}`);
    for (const record of geometry.slice(0, 6)) {
        console.log(
            `  id=${record.id} type=${record.type} refs=[${record.refIds.join(', ')}] marker=0x${record.markerByte.toString(16)}`,
        );
    }
}