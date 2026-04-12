#!/usr/bin/env node
/**
 * investigate107.mjs — Ordered coedge-chain survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Recover the single ordered coedge chain exposed by compact type-18 records.
 * 2. Measure head/tail stability and full-chain coverage across the sample set.
 * 3. Provide a clean starting point for later loop/edge segmentation work.
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

console.log('=== ORDERED COEDGE CHAIN SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const coedges = parser.parseCoedgeRecords();
    const chain = parser.parseCoedgeChain();

    console.log(`\n${fileName}`);
    console.log(`  coedges=${coedges.length}`);
    if (!chain) {
        console.log('  chain=null');
        continue;
    }

    console.log(
        `  head=${chain.headCoedgeId} tail=${chain.tailCoedgeId} ` +
        `terminalPrev=${chain.terminalPrevId} terminalNext=${chain.terminalNextId}`,
    );
    console.log(`  coverage=${chain.orderedCoedges.length}/${coedges.length}`);
    console.log(
        `  first=[${chain.orderedCoedges.slice(0, 5).map(record => record.id).join(', ')}] ` +
        `last=[${chain.orderedCoedges.slice(-5).map(record => record.id).join(', ')}]`,
    );
}