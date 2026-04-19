#!/usr/bin/env bun
/**
 * investigate210.mjs — Probe localized torus anchors from bounded plane faces.
 *
 * Goal:
 * determine whether current bounded plane faces already expose recoverable
 * torus families without reviving the old whole-plane overgeneration path.
 *
 * Clean-room basis:
 * - use only current parser output (surfaces, bounded faces, associated vertices)
 * - compare against public NIST STEP toroidal surface placements
 * - classify plane-local signatures rather than relying on proprietary schema
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSample, listSamplePaths } from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const AXIS_DOT_MIN = 0.98;
const ORIGIN_TOL = 1.0;
const RADIUS_TOL = 0.75;
const CLUSTER_TOL = 0.75;

function referencePathForSample(fileName) {
    const lower = fileName.toLowerCase();
    const definitionDir = lower.includes('_ctc_') ? 'CTC Definitions' : 'FTC Definitions';
    return path.join(
        REFERENCE_ROOT,
        definitionDir,
        lower.replace('_sw1802.sldprt', '.stp'),
    );
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function parseStepEntities(text) {
    const entities = new Map();
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;

    const joined = normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
    const lineRe = /^#(\d+)\s*=\s*(.+);$/gm;
    let match;
    while ((match = lineRe.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complex = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complex) {
            const types = complex[1].split(',').map((value) => value.trim());
            entities.set(id, { type: types.sort().join(','), types, args: complex[2] });
            continue;
        }

        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) {
            entities.set(id, { type: simple[1], types: [simple[1]], args: simple[2] });
            continue;
        }

        entities.set(id, { type: '???', types: [], args: rest });
    }

    return entities;
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseNumberTuple(text) {
    return text
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => !Number.isNaN(value));
}

function resolveCartesianPoint(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('CARTESIAN_POINT')) return null;

    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    return match ? parseNumberTuple(match[1]) : null;
}

function resolveDirection(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('DIRECTION')) return null;

    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    return normalizeTuple(parseNumberTuple(match[1]));
}

function resolveAxis2Placement(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('AXIS2_PLACEMENT_3D')) return null;

    const refs = extractRefs(entity.args);
    return {
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0]) : null,
        axis: refs[1] ? resolveDirection(entities, refs[1]) : null,
    };
}

function extractReferenceTori(stepText) {
    const entities = parseStepEntities(stepText);
    const lengthScale = detectLengthUnitScale(stepText);
    const tori = [];

    for (const [id, entity] of entities) {
        if (!entity.types.includes('TOROIDAL_SURFACE')) continue;

        const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
        if (!match) continue;

        const placement = resolveAxis2Placement(entities, Number(match[1]));
        if (!placement?.origin || !placement?.axis) continue;

        tori.push({
            id,
            origin: {
                x: placement.origin[0] * lengthScale,
                y: placement.origin[1] * lengthScale,
                z: placement.origin[2] * lengthScale,
            },
            axis: {
                x: placement.axis[0],
                y: placement.axis[1],
                z: placement.axis[2],
            },
            majorRadius: Number(match[2]) * lengthScale,
            minorRadius: Number(match[3]) * lengthScale,
        });
    }

    return tori;
}

function normalizeTuple(vector) {
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function normalizePoint(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function axisDot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance(pointA, pointB) {
    return Math.hypot(
        pointA.x - pointB.x,
        pointA.y - pointB.y,
        pointA.z - pointB.z,
    );
}

function distanceToAxis(point, axisOrigin, axisDirection) {
    const dx = point.x - axisOrigin.x;
    const dy = point.y - axisOrigin.y;
    const dz = point.z - axisOrigin.z;
    const along = dx * axisDirection.x + dy * axisDirection.y + dz * axisDirection.z;
    const px = dx - along * axisDirection.x;
    const py = dy - along * axisDirection.y;
    const pz = dz - along * axisDirection.z;
    return Math.hypot(px, py, pz);
}

function clusterValues(values, tolerance) {
    if (values.length === 0) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const groups = [];
    let current = [sorted[0]];

    for (let index = 1; index < sorted.length; index++) {
        if (Math.abs(sorted[index] - current[current.length - 1]) <= tolerance) current.push(sorted[index]);
        else {
            groups.push(current);
            current = [sorted[index]];
        }
    }
    groups.push(current);

    return groups.map((group) => ({
        center: group.reduce((sum, value) => sum + value, 0) / group.length,
        count: group.length,
    }));
}

function roundValue(value, digits = 3) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function summarizeCandidate(candidate) {
    return {
        signature: candidate.signature,
        surfaceId: candidate.surfaceId,
        faceCount: candidate.faceCount,
        support: candidate.support,
        holeRadius: roundValue(candidate.holeRadius),
        majorRadius: roundValue(candidate.majorRadius),
        minorRadius: roundValue(candidate.minorRadius),
        origin: {
            x: roundValue(candidate.origin.x),
            y: roundValue(candidate.origin.y),
            z: roundValue(candidate.origin.z),
        },
    };
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters);

console.log('investigate210 — bounded-plane torus anchor probe');
console.log('Clean-room basis: derive torus candidates only from bounded plane faces, nearby cylinder circles, and associated vertex radii.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const referenceTori = extractReferenceTori(fs.readFileSync(referencePathForSample(fileName), 'utf8'));
    if (referenceTori.length === 0) continue;

    const model = parser.parse();
    const surfaces = model.surfaces;
    const vertices = model.vertices;
    const vertexSurfaceMap = parser.associateVertices(surfaces, vertices);
    const cylSurfaces = surfaces.filter(
        (surface) => surface.surfaceType === 'cylinder' || surface.surfaceType === 'cone',
    );

    const candidates = [];

    for (const surface of surfaces) {
        if (surface.surfaceType !== 'plane') continue;

        const planeOrigin = surface.params.origin;
        const planeNormal = normalizePoint(surface.params.normal);
        const assocIndices = vertexSurfaceMap.get(surface.id) ?? [];
        const boundaryClusters = parser.buildPlaneBoundaryClusters(
            planeOrigin,
            planeNormal,
            assocIndices,
            vertices,
        );
        const faceCount = model.faces.filter((face) => face.surface === surface.id).length;

        for (const boundaryPts of boundaryClusters) {
            const boundarySet = new Set(boundaryPts.map((point) => point.idx));
            const boundaryVertices = boundaryPts.map((point) => vertices[point.idx].position);
            const holeCandidates = parser.collectPlaneHoleCandidates(
                planeOrigin,
                planeNormal,
                boundaryPts,
                cylSurfaces,
                vertices,
                vertexSurfaceMap,
            );

            for (const holeCandidate of holeCandidates) {
                const radii = boundaryVertices
                    .map((point) => distanceToAxis(point, holeCandidate.center, planeNormal))
                    .filter((radius) => radius > 0.1);

                for (const cluster of clusterValues(radii, CLUSTER_TOL)) {
                    if (cluster.count < 2) continue;

                    const minorRadius = Math.abs(cluster.center - holeCandidate.radius);
                    if (minorRadius < 0.5 || minorRadius > 6) continue;

                    candidates.push({
                        signature: 'plane-hole-boundary',
                        surfaceId: surface.id,
                        faceCount,
                        support: cluster.count,
                        holeRadius: holeCandidate.radius,
                        majorRadius: cluster.center,
                        minorRadius,
                        origin: {
                            x: holeCandidate.center.x + planeNormal.x * minorRadius,
                            y: holeCandidate.center.y + planeNormal.y * minorRadius,
                            z: holeCandidate.center.z + planeNormal.z * minorRadius,
                        },
                        axis: planeNormal,
                        boundarySize: boundarySet.size,
                    });
                }
            }

            if (holeCandidates.length > 0) continue;
            if (boundaryPts.length < 4 || boundaryPts.length > 8) continue;

            const center = boundaryVertices.reduce(
                (acc, point) => ({
                    x: acc.x + point.x / boundaryVertices.length,
                    y: acc.y + point.y / boundaryVertices.length,
                    z: acc.z + point.z / boundaryVertices.length,
                }),
                { x: 0, y: 0, z: 0 },
            );
            const boundaryRadii = boundaryVertices.map((point) => distanceToAxis(point, center, planeNormal));
            const radialClusters = clusterValues(boundaryRadii, CLUSTER_TOL).filter((cluster) => cluster.count >= 3);
            if (radialClusters.length !== 1) continue;

            const boundaryRadius = radialClusters[0].center;
            const tangentCylinder = cylSurfaces
                .filter((candidate) => candidate.surfaceType === 'cylinder')
                .map((candidate) => ({
                    surface: candidate,
                    axis: normalizePoint(candidate.params.axis),
                    lineDistance: distanceToAxis(center, candidate.params.origin, normalizePoint(candidate.params.axis)),
                    radius: candidate.params.radius,
                }))
                .filter((candidate) => {
                    if (Math.abs(Math.abs(axisDot(candidate.axis, planeNormal)) - 1) > 0.02) return false;
                    if (candidate.lineDistance > 1.5) return false;
                    const delta = Math.abs(boundaryRadius - candidate.radius);
                    return delta >= 0.5 && delta <= 6;
                })
                .sort((left, right) => {
                    const leftDelta = Math.abs(boundaryRadius - left.radius);
                    const rightDelta = Math.abs(boundaryRadius - right.radius);
                    return left.lineDistance - right.lineDistance || leftDelta - rightDelta;
                })[0];

            if (!tangentCylinder) continue;

            candidates.push({
                signature: 'plane-patch-cylinder',
                surfaceId: surface.id,
                faceCount,
                support: radialClusters[0].count,
                holeRadius: tangentCylinder.radius,
                majorRadius: boundaryRadius,
                minorRadius: Math.abs(boundaryRadius - tangentCylinder.radius),
                origin: {
                    x: center.x + planeNormal.x * Math.abs(boundaryRadius - tangentCylinder.radius),
                    y: center.y + planeNormal.y * Math.abs(boundaryRadius - tangentCylinder.radius),
                    z: center.z + planeNormal.z * Math.abs(boundaryRadius - tangentCylinder.radius),
                },
                axis: planeNormal,
                boundarySize: boundarySet.size,
            });
        }
    }

    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = [
            candidate.signature,
            roundValue(candidate.origin.x, 3),
            roundValue(candidate.origin.y, 3),
            roundValue(candidate.origin.z, 3),
            roundValue(candidate.axis.x, 3),
            roundValue(candidate.axis.y, 3),
            roundValue(candidate.axis.z, 3),
            roundValue(candidate.majorRadius, 3),
            roundValue(candidate.minorRadius, 3),
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
    }

    const matches = referenceTori.map((torus) => {
        const match = deduped.find((candidate) => {
            return Math.abs(candidate.majorRadius - torus.majorRadius) <= RADIUS_TOL &&
                Math.abs(candidate.minorRadius - torus.minorRadius) <= RADIUS_TOL &&
                Math.abs(axisDot(candidate.axis, normalizePoint(torus.axis))) >= AXIS_DOT_MIN &&
                distance(candidate.origin, torus.origin) <= ORIGIN_TOL;
        });
        return { torus, match };
    });

    const matched = matches.filter((entry) => entry.match);
    const bySignature = new Map();
    for (const candidate of deduped) {
        const entry = bySignature.get(candidate.signature) ?? { count: 0, exact: 0 };
        entry.count++;
        if (matches.some((match) => match.match === candidate)) entry.exact++;
        bySignature.set(candidate.signature, entry);
    }

    console.log(`\n== ${fileName.replace('_sw1802.SLDPRT', '')} ==`);
    console.log(`reference tori=${referenceTori.length}`);
    console.log(`  bounded-face candidates: ${deduped.length}`);
    console.log(`  exact reference matches: ${matched.length}/${referenceTori.length}`);
    for (const [signature, entry] of [...bySignature.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        console.log(`  ${signature}: ${entry.exact}/${entry.count} exact`);
    }

    const matchedPreview = matched
        .slice(0, 8)
        .map((entry) => ({
            refId: entry.torus.id,
            ref: {
                origin: {
                    x: roundValue(entry.torus.origin.x),
                    y: roundValue(entry.torus.origin.y),
                    z: roundValue(entry.torus.origin.z),
                },
                majorRadius: roundValue(entry.torus.majorRadius),
                minorRadius: roundValue(entry.torus.minorRadius),
            },
            candidate: summarizeCandidate(entry.match),
        }));
    if (matchedPreview.length > 0) {
        console.log('  matched examples:');
        console.log(JSON.stringify(matchedPreview, null, 2));
    }

    const unmatchedPreview = matches
        .filter((entry) => !entry.match)
        .slice(0, 8)
        .map((entry) => ({
            refId: entry.torus.id,
            origin: {
                x: roundValue(entry.torus.origin.x),
                y: roundValue(entry.torus.origin.y),
                z: roundValue(entry.torus.origin.z),
            },
            majorRadius: roundValue(entry.torus.majorRadius),
            minorRadius: roundValue(entry.torus.minorRadius),
        }));
    if (unmatchedPreview.length > 0) {
        console.log('  unmatched reference preview:');
        console.log(JSON.stringify(unmatchedPreview, null, 2));
    }
}