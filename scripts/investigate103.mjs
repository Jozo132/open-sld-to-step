#!/usr/bin/env node
/**
 * investigate103.mjs — Cross-file Parasolid schema metadata survey
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Parse the schema envelope from every downloaded NIST SolidWorks sample.
 * 2. Compare field-layout tokens, named class blocks, and class relations.
 * 3. Establish a reusable metadata baseline before deeper entity decoding.
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

function pad(value, width) {
    return String(value).padEnd(width, ' ');
}

function printCounts(title, entries, limit = 20) {
    console.log(`\n=== ${title} ===`);
    for (const [key, count] of entries.slice(0, limit)) {
        console.log(`${String(count).padStart(3)}  ${key}`);
    }
}

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

const summaries = [];
const schemaCounts = new Map();
const fieldTypeCounts = new Map();
const fieldNameCounts = new Map();
const classRelationCounts = new Map();
const classNameCounts = new Map();

for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const buffer = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(buffer);
    if (!extracted) {
        console.log(`Skipping ${fileName}: no Parasolid payload`);
        continue;
    }

    const parser = new ParasolidParser(extracted.data);
    const metadata = parser.parseSchemaMetadata();
    if (!metadata) {
        console.log(`Skipping ${fileName}: no schema metadata`);
        continue;
    }

    increment(schemaCounts, metadata.schemaId);
    for (const fieldDefinition of metadata.fieldDefinitions) {
        increment(fieldTypeCounts, `${fieldDefinition.typeCodes} -> ${fieldDefinition.name}`);
        increment(fieldNameCounts, fieldDefinition.name);
    }
    for (const namedClass of metadata.namedClasses) {
        increment(classNameCounts, namedClass.name);
        const fieldSpan = namedClass.fieldEnd >= namedClass.fieldStart
            ? namedClass.fieldEnd - namedClass.fieldStart + 1
            : 0;
        increment(
            classRelationCounts,
            `${namedClass.classType} parent=${namedClass.parentId} fields=${namedClass.fieldStart}..${namedClass.fieldEnd} span=${fieldSpan}`,
        );
    }

    summaries.push({
        fileName,
        schemaId: metadata.schemaId,
        fieldCount: metadata.fieldDefinitions.length,
        classCount: metadata.namedClasses.length,
        metadataEnd: metadata.metadataEndOffset,
        firstEntity: metadata.firstEntityOffset,
        firstSentinel: metadata.firstSentinelOffset,
    });
}

console.log('=== PARASOLID SCHEMA METADATA SUMMARY ===');
console.log(
    `${pad('FILE', 34)} ${pad('SCHEMA', 26)} ${pad('FIELDS', 8)} ${pad('CLASSES', 8)} ${pad('META_END', 10)} ${pad('FIRST_ENTITY', 12)} FIRST_SENTINEL`,
);
for (const summary of summaries) {
    console.log(
        `${pad(summary.fileName, 34)} ${pad(summary.schemaId, 26)} ${pad(summary.fieldCount, 8)} ${pad(summary.classCount, 8)} ` +
        `${pad(summary.metadataEnd, 10)} ${pad(summary.firstEntity ?? '-', 12)} ${summary.firstSentinel ?? '-'}`,
    );
}

printCounts(
    'Schema IDs',
    [...schemaCounts.entries()].sort((a, b) => b[1] - a[1]),
    10,
);
printCounts(
    'Most Common Field Tokens',
    [...fieldTypeCounts.entries()].sort((a, b) => b[1] - a[1]),
    25,
);
printCounts(
    'Most Common Field Names',
    [...fieldNameCounts.entries()].sort((a, b) => b[1] - a[1]),
    25,
);
printCounts(
    'Most Common Named Classes',
    [...classNameCounts.entries()].sort((a, b) => b[1] - a[1]),
    25,
);
printCounts(
    'Most Common Class Relations',
    [...classRelationCounts.entries()].sort((a, b) => b[1] - a[1]),
    25,
);