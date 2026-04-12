#!/usr/bin/env node
/**
 * investigate108.mjs — Type-16 edge component survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Decode compact type-16 records whose sentinel starts the payload area.
 * 2. Recover ordered prev/next components instead of assuming one global chain.
 * 3. Measure cross-file component counts and external anchor ids.
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

console.log('=== TYPE-16 EDGE COMPONENT SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const edges = parser.parseEdgeRecords();
    const components = parser.parseEdgeComponents();

    console.log(`\n${fileName}`);
    console.log(`  edges=${edges.length} components=${components.length}`);
    for (const component of components.slice(0, 12)) {
        console.log(
            `  head=${component.headEdgeId} tail=${component.tailEdgeId} ` +
            `prev=${component.terminalPrevId} next=${component.terminalNextId} ` +
            `length=${component.orderedEdges.length}`,
        );
    }
}