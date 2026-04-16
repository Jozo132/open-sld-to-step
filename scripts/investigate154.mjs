#!/usr/bin/env node
/**
 * investigate154.mjs
 *
 * Audit raw FACE geometryLikeId values against the existing geometry-like
 * alias layer. The goal is to see whether face geometry ids that do not
 * directly match extracted surface ids become resolvable after canonicalizing
 * through parseAllGeometryLikeRecords().
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate154.mjs
 *   node scripts/investigate154.mjs ftc_08 ftc_09
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

const parserModulePath = path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js');
const containerModulePath = path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js');
if (!fs.existsSync(parserModulePath) || !fs.existsSync(containerModulePath)) {
    throw new Error('Build output not found. Run "npm run build" before investigate154.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { SldprtContainerParser } = await import(pathToFileURL(containerModulePath).href);

const filters = process.argv.slice(2);

function listSamplePaths(activeFilters = []) {
    if (!fs.existsSync(SAMPLE_DIR)) {
        throw new Error(`Sample directory not found: ${SAMPLE_DIR}`);
    }

    const sampleNames = fs.readdirSync(SAMPLE_DIR)
        .filter((name) => name.toLowerCase().endsWith('.sldprt'))
        .sort((left, right) => left.localeCompare(right));
    if (activeFilters.length === 0) {
        return sampleNames.map((name) => path.join(SAMPLE_DIR, name));
    }

    const loweredFilters = activeFilters.map((value) => value.toLowerCase());
    return sampleNames
        .filter((name) => loweredFilters.some((value) => name.toLowerCase().includes(value)))
        .map((name) => path.join(SAMPLE_DIR, name));
}

function loadSample(samplePath) {
    const buffer = fs.readFileSync(samplePath);
    const extraction = SldprtContainerParser.extractParasolid(buffer);
    if (!extraction) {
        throw new Error(`Failed to extract Parasolid payload from ${path.basename(samplePath)}`);
    }

    return {
        fileName: path.basename(samplePath),
        parser: new ParasolidParser(extraction.data),
    };
}

const summary = [];

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const directSurfaceTypes = new Map(parser.extractSurfaces().map((surface) => [surface.id, surface.surfaceType]));
    const geometryLikeById = new Map(parser.parseAllGeometryLikeRecords().map((record) => [record.id, record]));

    let totalFaces = 0;
    let directResolved = 0;
    let aliasResolvedExtra = 0;
    const examples = [];

    for (const faceRecord of parser.parseFaceRecords()) {
        totalFaces++;

        const directType = directSurfaceTypes.get(faceRecord.geometryLikeId) ?? null;
        if (directType !== null) {
            directResolved++;
            continue;
        }

        const geometryLike = geometryLikeById.get(faceRecord.geometryLikeId);
        if (!geometryLike) continue;

        const canonicalId = 'canonicalId' in geometryLike ? geometryLike.canonicalId : geometryLike.id;
        const aliasType = directSurfaceTypes.get(canonicalId) ?? null;
        if (aliasType === null) continue;

        aliasResolvedExtra++;
        if (examples.length < 8) {
            examples.push({
                faceId: faceRecord.id,
                geometryLikeId: faceRecord.geometryLikeId,
                canonicalId,
                aliasType,
            });
        }
    }

    summary.push({
        fileName,
        totalFaces,
        directResolved,
        aliasResolvedExtra,
        examples,
    });
}

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));