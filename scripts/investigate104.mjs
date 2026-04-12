#!/usr/bin/env node
/**
 * investigate104.mjs — First pre-sentinel entity header survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Inspect the first entity header immediately before the sentinel zone.
 * 2. Confirm whether the compact or packed header form is used.
 * 3. Establish stable offsets/types/ids for later schema-to-entity mapping.
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

function hexSlice(buf, start, end) {
    return [...buf.subarray(start, end)].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
}

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== FIRST PRE-SENTINEL ENTITY HEADERS ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const metadata = parser.parseSchemaMetadata();
    if (!metadata?.firstSentinelOffset || metadata.firstEntityOffset === null) {
        console.log(`${fileName}: no first entity detected`);
        continue;
    }

    const edgeStart = Math.max(metadata.metadataEndOffset, metadata.firstSentinelOffset - 24);
    console.log(`\n${fileName}`);
    console.log(`  metadataEnd=${metadata.metadataEndOffset} firstEntity=${metadata.firstEntityOffset} firstSentinel=${metadata.firstSentinelOffset}`);
    if (metadata.firstEntityHeader) {
        console.log(
            `  header=${metadata.firstEntityHeader.format} type=${metadata.firstEntityHeader.type} ` +
            `id=${metadata.firstEntityHeader.id} flags=${metadata.firstEntityHeader.flags} ` +
            `trailer=${metadata.firstEntityHeader.trailer ?? '-'}`,
        );
    }
    console.log(`  bytes=${hexSlice(extracted.data, edgeStart, metadata.firstSentinelOffset + 8)}`);
}