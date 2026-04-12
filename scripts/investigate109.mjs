#!/usr/bin/env node
/**
 * investigate109.mjs — Type-16 edge component chain survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Reconstruct higher-level chains of type-16 components via their anchor ids.
 * 2. Distinguish fully linked component chains from isolated components.
 * 3. Provide a clean baseline before joining the type-16 layer to type-15/type-30 records.
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

console.log('=== TYPE-16 EDGE COMPONENT CHAIN SURVEY ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const components = parser.parseEdgeComponents();
    const chains = parser.parseEdgeComponentChains();

    console.log(`\n${fileName}`);
    console.log(`  components=${components.length} chains=${chains.length}`);
    for (const chain of chains.slice(0, 12)) {
        console.log(
            `  head=${chain.headEdgeId} tail=${chain.tailEdgeId} ` +
            `prev=${chain.terminalPrevId} next=${chain.terminalNextId} ` +
            `components=${chain.orderedComponents.length}`,
        );
        console.log(
            `    componentHeads=[${chain.orderedComponents.map(component => component.headEdgeId).join(', ')}]`,
        );
    }
}