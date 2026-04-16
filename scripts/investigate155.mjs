#!/usr/bin/env node
/**
 * investigate155.mjs
 *
 * Derive coedge evidence from FACE-window slot words that resolve to either
 * direct COEDGE ids or POINT ids whose nextCoedgeId is known. Compare that
 * evidence against candidate.mappedCoedgeIds to see whether slot-local
 * topology can distinguish candidate or variant choices.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate155.mjs
 *   node scripts/investigate155.mjs ftc_07 ftc_08
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
    throw new Error('Build output not found. Run "npm run build" before investigate155.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { SldprtContainerParser } = await import(pathToFileURL(containerModulePath).href);

const PS_TO_MM = 1000;
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

function rebuild(parser) {
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
    return {
        candidates: parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap),
        hints: new Map(parser.parseRawFaceBoundaryHints().map((hint) => [hint.faceId, hint])),
        windows: new Map(parser.parseFaceInlineWindowRecords().map((record) => [record.faceId, record])),
    };
}

function parseCandidateKey(key) {
    const [surfaceType, surfaceIdText, variantText] = key.split(':');
    return {
        surfaceType,
        surfaceId: Number(surfaceIdText),
        variant: variantText === undefined ? null : Number(variantText),
    };
}

function compareOptions(left, right) {
    return left.score - right.score
        || left.candidate.totalSize - right.candidate.totalSize
        || left.candidate.outerSize - right.candidate.outerSize
        || left.candidate.key.localeCompare(right.candidate.key);
}

function deriveCoedgeEvidence(word, pointById, coedgeIds) {
    if (coedgeIds.has(word)) {
        return { source: 'coedge', coedgeIds: [word] };
    }

    const point = pointById.get(word);
    if (point && coedgeIds.has(point.nextCoedgeId)) {
        return {
            source: 'point',
            coedgeIds: [point.nextCoedgeId],
        };
    }

    return null;
}

function countMatches(coedgeIds, candidate) {
    const mapped = new Set(candidate.mappedCoedgeIds);
    let matches = 0;
    for (const coedgeId of coedgeIds) {
        if (mapped.has(coedgeId)) matches++;
    }
    return matches;
}

function increment(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

const slotStats = Array.from({ length: 20 }, () => ({
    evidenceHits: 0,
    sourceCounts: new Map(),
    noCandidateMatch: 0,
    bestHasMatch: 0,
    bestAtMax: 0,
    changedByEvidence: 0,
    variantOnlyChange: 0,
    sameBucketCases: 0,
    sameBucketBestSupported: 0,
    sameBucketVariantChange: 0,
    examples: [],
}));

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const { candidates, hints, windows } = rebuild(parser);
    const pointById = new Map(parser.parsePointRecords().map((record) => [record.id, record]));
    const coedgeIds = new Set(parser.parseCoedgeRecords().map((record) => record.id));

    for (const [faceId, hint] of hints) {
        const window = windows.get(faceId);
        if (!window) continue;

        const options = candidates
            .map((candidate) => {
                const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
                return match ? { candidate, score: match.score } : null;
            })
            .filter(Boolean)
            .sort(compareOptions);
        if (options.length === 0) continue;

        const best = options[0];
        const bestInfo = parseCandidateKey(best.candidate.key);

        window.words.forEach((word, slotIndex) => {
            const evidence = deriveCoedgeEvidence(word, pointById, coedgeIds);
            if (!evidence) return;

            const stat = slotStats[slotIndex];
            stat.evidenceHits++;
            increment(stat.sourceCounts, evidence.source);

            const optionMatches = options.map((option) => ({
                ...option,
                coedgeMatchCount: countMatches(evidence.coedgeIds, option.candidate),
            }));
            const positive = optionMatches.filter((option) => option.coedgeMatchCount > 0);
            if (positive.length === 0) {
                stat.noCandidateMatch++;
                if (stat.examples.length < 8) {
                    stat.examples.push({
                        fileName,
                        faceId,
                        word,
                        source: evidence.source,
                        evidenceCoedgeIds: evidence.coedgeIds,
                        bestKey: best.candidate.key,
                        bestScore: best.score,
                        evidenceWinner: null,
                    });
                }
                return;
            }

            const bestMatchCount = optionMatches[0].coedgeMatchCount;
            if (bestMatchCount > 0) stat.bestHasMatch++;

            const maxMatch = Math.max(...optionMatches.map((option) => option.coedgeMatchCount));
            if (bestMatchCount === maxMatch) stat.bestAtMax++;

            const evidenceWinners = optionMatches
                .filter((option) => option.coedgeMatchCount === maxMatch)
                .sort(compareOptions);
            const evidenceWinner = evidenceWinners[0];

            if (evidenceWinner.candidate.key !== best.candidate.key) {
                stat.changedByEvidence++;

                const evidenceInfo = parseCandidateKey(evidenceWinner.candidate.key);
                if (evidenceInfo.surfaceType === bestInfo.surfaceType && evidenceInfo.surfaceId === bestInfo.surfaceId) {
                    stat.variantOnlyChange++;
                }
            }

            const sameBucket = optionMatches
                .filter((option) => {
                    const info = parseCandidateKey(option.candidate.key);
                    return info.surfaceType === bestInfo.surfaceType && info.surfaceId === bestInfo.surfaceId;
                })
                .sort(compareOptions);
            if (sameBucket.length > 1) {
                stat.sameBucketCases++;
                const sameBucketMax = Math.max(...sameBucket.map((option) => option.coedgeMatchCount));
                if (sameBucketMax > 0) {
                    const sameBucketWinner = sameBucket
                        .filter((option) => option.coedgeMatchCount === sameBucketMax)
                        .sort(compareOptions)[0];
                    if (sameBucketWinner.candidate.key === best.candidate.key) {
                        stat.sameBucketBestSupported++;
                    } else {
                        stat.sameBucketVariantChange++;
                    }
                }
            }

            if (stat.examples.length < 8) {
                stat.examples.push({
                    fileName,
                    faceId,
                    word,
                    source: evidence.source,
                    evidenceCoedgeIds: evidence.coedgeIds,
                    bestKey: best.candidate.key,
                    bestScore: best.score,
                    bestCoedgeMatchCount: bestMatchCount,
                    evidenceWinner: {
                        key: evidenceWinner.candidate.key,
                        score: evidenceWinner.score,
                        coedgeMatchCount: evidenceWinner.coedgeMatchCount,
                    },
                });
            }
        });
    }
}

const summary = slotStats.map((stat, slotIndex) => ({
    slotIndex,
    byteOffset: 30 + slotIndex * 2,
    evidenceHits: stat.evidenceHits,
    sourceCounts: [...stat.sourceCounts.entries()].sort((left, right) => right[1] - left[1]),
    noCandidateMatch: stat.noCandidateMatch,
    bestHasMatch: stat.bestHasMatch,
    bestAtMax: stat.bestAtMax,
    changedByEvidence: stat.changedByEvidence,
    variantOnlyChange: stat.variantOnlyChange,
    sameBucketCases: stat.sameBucketCases,
    sameBucketBestSupported: stat.sameBucketBestSupported,
    sameBucketVariantChange: stat.sameBucketVariantChange,
    examples: stat.examples,
})).filter((entry) => entry.evidenceHits > 0);

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));