#!/usr/bin/env node
/**
 * investigate115.mjs — Geometry-like alias survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Test whether unresolved edge geometryLikeId values map uniquely to refIds[1]
 *    of existing compact or packed geometry-like records.
 * 2. Measure ambiguity before adding any alias decoder logic.
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

console.log('=== GEOMETRY-LIKE ALIAS SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const records = parser.parseAllGeometryLikeRecords();
    const direct = new Set(records.map(record => record.id));
    const aliasMap = new Map();

    for (const record of records) {
        const aliasId = record.refIds[1];
        const bucket = aliasMap.get(aliasId) ?? [];
        bucket.push(record);
        aliasMap.set(aliasId, bucket);
    }

    const edges = parser.parseEdgeRecords();
    const unresolved = [...new Set(edges.map(edge => edge.geometryLikeId).filter(id => !direct.has(id)))];
    const aliasResolved = unresolved.filter(id => (aliasMap.get(id)?.length ?? 0) === 1);
    const ambiguous = unresolved.filter(id => (aliasMap.get(id)?.length ?? 0) > 1);

    const aliasOnlyEdgeCount = edges.filter(edge => !direct.has(edge.geometryLikeId) && (aliasMap.get(edge.geometryLikeId)?.length ?? 0) === 1).length;
    const collisions = [...aliasMap.entries()].filter(([, bucket]) => bucket.length > 1).length;

    console.log(`\n${fileName}`);
    console.log(`  unresolved=[${unresolved.join(', ')}]`);
    console.log(`  aliasResolved=${aliasResolved.length}/${unresolved.length} aliasOnlyEdgeCount=${aliasOnlyEdgeCount} collisions=${collisions}`);
    if (ambiguous.length > 0) {
        console.log(`  ambiguous=[${ambiguous.join(', ')}]`);
    }

    for (const id of aliasResolved.slice(0, 8)) {
        const record = aliasMap.get(id)[0];
        console.log(
            `  alias ${id} -> recordId=${record.id} type=${record.type} refs=[${record.refIds.join(', ')}] marker=0x${record.markerByte.toString(16)}`,
        );
    }
}