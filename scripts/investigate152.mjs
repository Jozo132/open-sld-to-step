#!/usr/bin/env node
/**
 * investigate152.mjs
 *
 * Classify the stable 30-69 byte raw FACE window against decoded entity-id
 * sets and raw extracted surface ids. This stays at the clean-room structural
 * layer: it only reports which slots repeatedly resolve to already-decoded ids.
 *
 * Usage:
 *   node scripts/investigate152.mjs
 *   node scripts/investigate152.mjs ftc_07 ftc_08
 */
import path from 'node:path';
import fs from 'node:fs';
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
    throw new Error('Build output not found. Run "npm run build" before investigate152.mjs.');
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

const samplePaths = listSamplePaths(filters);

const PS_TO_MM = 1000;

function increment(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function rebuildCandidates(parser) {
    const points = parser.extractCoordinates();
    const vertices = points.map((point, index) => ({
        id: index + 1,
        position: {
            x: point.x * PS_TO_MM,
            y: point.y * PS_TO_MM,
            z: point.z * PS_TO_MM,
        },
    }));

    const extractedSurfaces = parser.extractSurfaces();
    const validated = [];
    for (const surface of extractedSurfaces) {
        if (surface.surfaceType !== 'plane') {
            validated.push(surface);
            continue;
        }

        const params = surface.params;
        const coplanar = [];
        for (const vertex of vertices) {
            const dx = vertex.position.x - params.origin.x;
            const dy = vertex.position.y - params.origin.y;
            const dz = vertex.position.z - params.origin.z;
            const distance = Math.abs(
                dx * params.normal.x + dy * params.normal.y + dz * params.normal.z,
            );
            if (distance < 0.5) coplanar.push(vertex.position);
        }
        if (coplanar.length < 3) continue;

        const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, params.normal);
        if (ratio <= 2.5) validated.push(surface);
    }

    const inferredPlanes = parser.inferPlanesFromVertices(
        ParasolidParser.filterOutlierVertices(vertices),
        validated,
    );
    const merged = ParasolidParser.recoverAxisymmetricWasherSurfaces(
        [...validated, ...inferredPlanes],
        vertices,
    );
    const apexCones = parser.inferApexConesFromCylinderPairs(merged, vertices);
    const drillTipCones = parser.inferDrillTipConesFromRawCylinderSections(validated, vertices, apexCones);
    const halfRadiusCones = parser.inferHalfRadiusDrillTipConesFromRawCylinderSections(validated, vertices);
    const repeatedCenterCones = parser.inferRepeatedCenterCylinderDrillTipCones(
        validated,
        vertices,
        halfRadiusCones,
    );
    const surfaces = parser.deduplicateSurfaces([
        ...merged,
        ...apexCones,
        ...drillTipCones,
        ...halfRadiusCones,
        ...repeatedCenterCones,
    ]);

    surfaces.forEach((surface, index) => {
        surface.id = index + 1;
    });

    const vertexSurfaceMap = parser.associateVertices(surfaces, vertices);
    const candidates = parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap);
    const hints = new Map(parser.parseRawFaceBoundaryHints().map((hint) => [hint.faceId, hint]));

    return { candidates, hints };
}

function classifyWord(word, record, entitySets) {
    if (word === 0) return 'zero';
    if (word === record.faceId) return 'self-face';
    if (record.shellId !== null && word === record.shellId) return 'self-shell';
    if (entitySets.rawSurfaceTypeById.has(word)) return `raw-surface:${entitySets.rawSurfaceTypeById.get(word)}`;
    if (entitySets.geometryIds.has(word)) return 'geometry-like';
    if (entitySets.edgeIds.has(word)) return 'edge';
    if (entitySets.coedgeIds.has(word)) return 'coedge';
    if (entitySets.pointIds.has(word)) return 'point';
    if (entitySets.faceIds.has(word)) return 'face';
    if (entitySets.shellIds.has(word)) return 'shell';
    return 'other';
}

const slotStats = Array.from({ length: 20 }, () => ({
    labels: new Map(),
    bestTypeMatches: 0,
    bestTypeMismatches: 0,
    examples: [],
}));

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const { candidates, hints } = rebuildCandidates(parser);
    const entitySets = {
        edgeIds: new Set(parser.parseEdgeRecords().map((record) => record.id)),
        coedgeIds: new Set(parser.parseCoedgeRecords().map((record) => record.id)),
        pointIds: new Set(parser.parsePointRecords().map((record) => record.id)),
        faceIds: new Set(parser.parseFaceRecords().map((record) => record.id)),
        shellIds: new Set(parser.extractAllEntities().filter((entity) => entity.type === 0x11).map((entity) => entity.id)),
        geometryIds: new Set(parser.parseAllGeometryLikeRecords().map((record) => record.id)),
        rawSurfaceTypeById: new Map(parser.extractSurfaces().map((surface) => [surface.id, surface.surfaceType])),
    };

    for (const record of parser.parseFaceInlineWindowRecords()) {
        const hint = hints.get(record.faceId);
        const best = hint
            ? candidates
                .map((candidate) => {
                    const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
                    return match ? { candidate, score: match.score } : null;
                })
                .filter(Boolean)
                .sort((left, right) => {
                    return left.score - right.score
                        || left.candidate.totalSize - right.candidate.totalSize
                        || left.candidate.outerSize - right.candidate.outerSize
                        || left.candidate.key.localeCompare(right.candidate.key);
                })[0]
            : null;

        record.words.forEach((word, index) => {
            const classification = classifyWord(word, record, entitySets);
            const stat = slotStats[index];

            increment(stat.labels, classification);
            if (classification.startsWith('raw-surface:') && best) {
                const surfaceType = classification.slice('raw-surface:'.length);
                if (surfaceType === best.candidate.surfaceType) stat.bestTypeMatches++;
                else stat.bestTypeMismatches++;
            }
            if (stat.examples.length < 6 && classification !== 'other') {
                stat.examples.push({
                    fileName,
                    faceId: record.faceId,
                    word,
                    classification,
                    bestType: best?.candidate.surfaceType ?? null,
                    bestKey: best?.candidate.key ?? null,
                });
            }
        });
    }
}

const summary = slotStats.map((stat, index) => ({
    slotIndex: index,
    byteOffset: 30 + index * 2,
    labels: [...stat.labels.entries()].sort((left, right) => right[1] - left[1]),
    bestTypeMatches: stat.bestTypeMatches,
    bestTypeMismatches: stat.bestTypeMismatches,
    examples: stat.examples,
}));

console.log(JSON.stringify({
    filters,
    sampleCount: samplePaths.length,
    summary,
}, null, 2));