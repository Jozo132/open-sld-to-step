#!/usr/bin/env node
/**
 * investigate106.mjs — Coedge and gap-point chain survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Decode compact type-18 coedge records and type-29 gap points.
 * 2. Measure prev/next coedge resolution and vertex-point resolution.
 * 3. Identify the strongest reusable invariants for regression coverage.
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

console.log('=== COEDGE / GAP-POINT CHAIN SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const coedges = parser.parseCoedgeRecords();
    const points = parser.parseGapPointRecords();
    const coedgeIds = new Set(coedges.map(record => record.id));
    const pointIds = new Set(points.map(record => record.id));

    const prevResolved = coedges.filter(record => coedgeIds.has(record.prevCoedgeId)).length;
    const nextResolved = coedges.filter(record => coedgeIds.has(record.nextCoedgeId)).length;
    const vertexResolved = coedges.filter(record => pointIds.has(record.vertexPointId)).length;

    console.log(`\n${fileName}`);
    console.log(`  coedges=${coedges.length} points=${points.length}`);
    console.log(`  prevResolved=${prevResolved}/${coedges.length}`);
    console.log(`  nextResolved=${nextResolved}/${coedges.length}`);
    console.log(`  vertexResolved=${vertexResolved}/${coedges.length}`);

    for (const record of coedges.slice(0, 8)) {
        console.log(
            `  coedge id=${record.id} prev=${record.prevCoedgeId} next=${record.nextCoedgeId} ` +
            `vertex=${record.vertexPointId} curve=${record.curveLikeId}`,
        );
    }
}