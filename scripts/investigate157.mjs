#!/usr/bin/env node
/**
 * investigate157.mjs
 *
 * Test the cross-face ownership hypothesis for FACE-window slot evidence.
 * For each slot-derived coedge (direct COEDGE id or POINT -> nextCoedgeId),
 * determine whether it belongs to the current raw face's selected target or
 * to another selected raw face target in the same model.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate157.mjs
 *   node scripts/investigate157.mjs ftc_07 ftc_08
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
    throw new Error('Build output not found. Run "npm run build" before investigate157.mjs.');
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
    const candidates = parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap);
    const hints = parser.parseRawFaceBoundaryHints();
    const targets = parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, hints);
    const candidatesByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const selectedByFaceId = new Map();
    for (const [key, target] of targets.entries()) {
        const candidate = candidatesByKey.get(key);
        if (!candidate) continue;
        selectedByFaceId.set(target.rawFaceId, {
            key,
            candidate,
            target,
        });
    }

    return {
        hints: new Map(hints.map((hint) => [hint.faceId, hint])),
        windows: new Map(parser.parseFaceInlineWindowRecords().map((record) => [record.faceId, record])),
        faceRecords: new Map(parser.parseFaceRecords().map((record) => [record.id, record])),
        selectedByFaceId,
    };
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

function increment(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

const slotStats = Array.from({ length: 20 }, () => ({
    evidenceHits: 0,
    sourceCounts: new Map(),
    currentOwnsAll: 0,
    currentOwnsAny: 0,
    otherFaceOwnsAny: 0,
    uniqueOtherOwner: 0,
    sameShellOtherOwner: 0,
    otherOnly: 0,
    noneOwned: 0,
    examples: [],
}));

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const { hints, windows, faceRecords, selectedByFaceId } = rebuild(parser);
    const pointById = new Map(parser.parsePointRecords().map((record) => [record.id, record]));
    const coedgeIds = new Set(parser.parseCoedgeRecords().map((record) => record.id));

    const ownerFacesByCoedgeId = new Map();
    for (const [rawFaceId, selected] of selectedByFaceId.entries()) {
        for (const coedgeId of selected.candidate.mappedCoedgeIds) {
            const bucket = ownerFacesByCoedgeId.get(coedgeId) ?? [];
            bucket.push(rawFaceId);
            ownerFacesByCoedgeId.set(coedgeId, bucket);
        }
    }

    for (const [faceId] of hints) {
        const window = windows.get(faceId);
        const selected = selectedByFaceId.get(faceId);
        if (!window || !selected) continue;

        const faceShellId = faceRecords.get(faceId)?.shellId ?? null;
        const selectedCoedgeSet = new Set(selected.candidate.mappedCoedgeIds);

        window.words.forEach((word, slotIndex) => {
            const evidence = deriveCoedgeEvidence(word, pointById, coedgeIds);
            if (!evidence) return;

            const stat = slotStats[slotIndex];
            stat.evidenceHits++;
            increment(stat.sourceCounts, evidence.source);

            const currentOwnedIds = evidence.coedgeIds.filter((coedgeId) => selectedCoedgeSet.has(coedgeId));
            const otherOwnerFaces = new Set();
            for (const coedgeId of evidence.coedgeIds) {
                const owners = ownerFacesByCoedgeId.get(coedgeId) ?? [];
                for (const ownerFaceId of owners) {
                    if (ownerFaceId !== faceId) otherOwnerFaces.add(ownerFaceId);
                }
            }

            if (currentOwnedIds.length === evidence.coedgeIds.length) stat.currentOwnsAll++;
            if (currentOwnedIds.length > 0) stat.currentOwnsAny++;
            if (otherOwnerFaces.size > 0) stat.otherFaceOwnsAny++;
            if (otherOwnerFaces.size === 1) stat.uniqueOtherOwner++;
            if (currentOwnedIds.length === 0 && otherOwnerFaces.size > 0) stat.otherOnly++;
            if (currentOwnedIds.length === 0 && otherOwnerFaces.size === 0) stat.noneOwned++;

            let sameShellOtherOwner = false;
            for (const ownerFaceId of otherOwnerFaces) {
                const ownerShellId = faceRecords.get(ownerFaceId)?.shellId ?? null;
                if (faceShellId !== null && ownerShellId === faceShellId) {
                    sameShellOtherOwner = true;
                    break;
                }
            }
            if (sameShellOtherOwner) stat.sameShellOtherOwner++;

            if (stat.examples.length < 8) {
                stat.examples.push({
                    fileName,
                    faceId,
                    word,
                    source: evidence.source,
                    evidenceCoedgeIds: evidence.coedgeIds,
                    selectedKey: selected.key,
                    currentOwnedIds,
                    otherOwnerFaces: [...otherOwnerFaces].sort((left, right) => left - right),
                    sameShellOtherOwner,
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
    currentOwnsAll: stat.currentOwnsAll,
    currentOwnsAny: stat.currentOwnsAny,
    otherFaceOwnsAny: stat.otherFaceOwnsAny,
    uniqueOtherOwner: stat.uniqueOtherOwner,
    sameShellOtherOwner: stat.sameShellOtherOwner,
    otherOnly: stat.otherOnly,
    noneOwned: stat.noneOwned,
    examples: stat.examples,
})).filter((entry) => entry.evidenceHits > 0);

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));