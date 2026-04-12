#!/usr/bin/env node
/**
 * investigate111.mjs — Extended compact geometry-like survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Extend the compact geometry index to types 32 and 38 when they share the same four-ref plus marker layout.
 * 2. Measure the resulting improvement in type-16 geometryLikeId resolution.
 * 3. Isolate the small remaining unresolved id set for the next decoder pass.
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

console.log('=== EXTENDED COMPACT GEOMETRY-LIKE SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const edges = parser.parseEdgeRecords();
    const base = new Set(parser.parseCompactGeometryRecords().map(record => record.id));
    const extended = parser.parseCompactGeometryLikeRecords();
    const extendedById = new Map(extended.map(record => [record.id, record]));
    const baseResolved = edges.filter(edge => base.has(edge.geometryLikeId)).length;
    const extendedResolved = edges.filter(edge => extendedById.has(edge.geometryLikeId)).length;
    const unresolved = [...new Set(edges.map(edge => edge.geometryLikeId).filter(id => !extendedById.has(id)))];

    console.log(`\n${fileName}`);
    console.log(`  baseResolved=${baseResolved}/${edges.length} extendedResolved=${extendedResolved}/${edges.length}`);
    console.log(`  unresolved=[${unresolved.slice(0, 20).join(', ')}]`);
    for (const record of extended.slice(0, 6)) {
        console.log(
            `  id=${record.id} type=${record.type} refs=[${record.refIds.join(', ')}] marker=0x${record.markerByte.toString(16)}`,
        );
    }
}