#!/usr/bin/env node
/**
 * investigate105.mjs — Sentinel-aligned linear record survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Parse all sentinel-aligned linear records across the NIST sample set.
 * 2. Compare packed vs compact record counts and dominant type codes.
 * 3. Surface stable ref patterns before class-to-entity mapping.
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

function increment(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
}

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

const roleCounts = new Map();
const typeCounts = new Map();
const refPatternCounts = new Map();

console.log('=== SENTINEL-ALIGNED LINEAR RECORDS ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const records = parser.parseSentinelAlignedEntities();

    console.log(`\n${fileName}`);
    console.log(`  records=${records.length}`);
    for (const record of records.slice(0, 12)) {
        console.log(
            `  role=${record.role} type=${record.header.type} id=${record.header.id} ` +
            `flags=${record.header.flags} trailer=${record.header.trailer ?? '-'} refs=[${record.refs.join(', ')}]`,
        );
    }

    for (const record of records) {
        increment(roleCounts, record.role);
        increment(typeCounts, `${record.role} type=${record.header.type}`);
        if (record.refs.length > 0) {
            increment(refPatternCounts, `${record.role} refs=${record.refs.length}:${record.refs.join(',')}`);
        }
    }
}

console.log('\n=== ROLE COUNTS ===');
for (const [key, count] of [...roleCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(4)}  ${key}`);
}

console.log('\n=== TYPE COUNTS ===');
for (const [key, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`${String(count).padStart(4)}  ${key}`);
}

console.log('\n=== REF PATTERNS ===');
for (const [key, count] of [...refPatternCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`${String(count).padStart(4)}  ${key}`);
}