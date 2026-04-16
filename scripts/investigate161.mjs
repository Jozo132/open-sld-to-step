#!/usr/bin/env node
/**
 * investigate161.mjs
 *
 * Evaluate whether expanding the non-axis plane-normal seed bank improves
 * inferred plane recall. The current parser only seeds non-axis inference from
 * validated extracted planes. This script compares that baseline against:
 *   - fixed 45° and 30°/60° manufacturing-angle normals
 *   - raw 0x1E plane-like directions, including rejected payloads
 *   - a combined bank
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate161.mjs
 *   node scripts/investigate161.mjs ctc_01 ftc_07 ftc_08
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
const CTC_REF_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions',
);
const FTC_REF_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
);

const parserModulePath = path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js');
const containerModulePath = path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js');
if (!fs.existsSync(parserModulePath) || !fs.existsSync(containerModulePath)) {
    throw new Error('Build output not found. Run "npm run build" before investigate161.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { SldprtContainerParser } = await import(pathToFileURL(containerModulePath).href);

const PS_TO_MM = 1000;
const VERTEX_PLANE_TOL = 0.5;
const PLANE_EIGEN_RATIO_MAX = 2.5;
const INFER_CLUSTER_TOL = 0.1;
const PLANE_EQ_MATCH_TOL = 1.0;
const DIRECTION_DOT_TOL = 0.999;
const SAMPLE_FILTERS = process.argv.slice(2).map((value) => value.toLowerCase());

function listSamplePaths() {
    const sampleNames = fs.readdirSync(SAMPLE_DIR)
        .filter((name) => name.toLowerCase().endsWith('.sldprt'))
        .sort((left, right) => left.localeCompare(right));
    if (SAMPLE_FILTERS.length === 0) {
        return sampleNames.map((name) => path.join(SAMPLE_DIR, name));
    }

    return sampleNames
        .filter((name) => SAMPLE_FILTERS.some((value) => name.toLowerCase().includes(value)))
        .map((name) => path.join(SAMPLE_DIR, name));
}

function resolveReferencePath(sampleName) {
    const refName = sampleName.replace(/_sw1802\.sldprt$/i, '.stp');
    const refDir = sampleName.includes('_ctc_') ? CTC_REF_DIR : FTC_REF_DIR;
    const refPath = path.join(refDir, refName);
    if (!fs.existsSync(refPath)) {
        throw new Error(`Reference STEP not found for ${sampleName}: ${refPath}`);
    }
    return refPath;
}

function canonicalNormal(normal) {
    const components = [normal.x, normal.y, normal.z];
    for (const component of components) {
        if (Math.abs(component) < 1e-9) continue;
        if (component < 0) {
            return { x: -normal.x, y: -normal.y, z: -normal.z };
        }
        break;
    }
    return { x: normal.x, y: normal.y, z: normal.z };
}

function normalizeDirection(direction) {
    const mag = Math.hypot(direction.x, direction.y, direction.z);
    if (mag < 1e-12) return null;
    return canonicalNormal({
        x: direction.x / mag,
        y: direction.y / mag,
        z: direction.z / mag,
    });
}

function isAxisAligned(normal) {
    return Math.abs(normal.x) > 0.99 || Math.abs(normal.y) > 0.99 || Math.abs(normal.z) > 0.99;
}

function addUniqueNormal(target, normal) {
    for (const existing of target) {
        const dot = Math.abs(
            existing.x * normal.x + existing.y * normal.y + existing.z * normal.z,
        );
        if (dot > DIRECTION_DOT_TOL) return false;
    }
    target.push(normal);
    return true;
}

function parseStepEntities(text) {
    const entities = new Map();
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;
    const data = normalized.slice(dataStart + 5, dataEnd);
    const joined = data.replace(/\n(?!#\d+=)/g, '');
    const lineRe = /^#(\d+)\s*=\s*(.+);$/gm;

    let match;
    while ((match = lineRe.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complexMatch = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complexMatch) {
            const types = complexMatch[1].split(',').map((value) => value.trim());
            entities.set(id, { types, args: complexMatch[2] });
            continue;
        }

        const simpleMatch = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simpleMatch) {
            entities.set(id, { types: [simpleMatch[1]], args: simpleMatch[2] });
            continue;
        }

        entities.set(id, { types: [], args: rest });
    }

    return entities;
}

function parseNumberTuple(text) {
    return text
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => !Number.isNaN(value));
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
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
    const tuple = parseNumberTuple(match[1]);
    const mag = Math.hypot(tuple[0], tuple[1], tuple[2]) || 1;
    return [tuple[0] / mag, tuple[1] / mag, tuple[2] / mag];
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

function extractReferencePlanes(text) {
    const entities = parseStepEntities(text);
    const scale = detectLengthUnitScale(text);
    const planes = [];

    for (const [id, entity] of entities) {
        if (!entity.types.includes('PLANE')) continue;
        const axisRef = extractRefs(entity.args)[0];
        const placement = axisRef ? resolveAxis2Placement(entities, axisRef) : null;
        if (!placement?.origin || !placement.axis) continue;
        const origin = placement.origin.map((value) => value * scale);
        const normal = normalizeDirection({
            x: placement.axis[0],
            y: placement.axis[1],
            z: placement.axis[2],
        });
        if (!normal) continue;
        planes.push({
            id,
            origin,
            normal,
            d: origin[0] * normal.x + origin[1] * normal.y + origin[2] * normal.z,
        });
    }

    return planes;
}

function planeDistance(left, right) {
    const dot = left.normal.x * right.normal.x
        + left.normal.y * right.normal.y
        + left.normal.z * right.normal.z;
    if (Math.abs(Math.abs(dot) - 1) > 0.02) return Infinity;
    const rightD = dot > 0 ? right.d : -right.d;
    return Math.abs(left.d - rightD);
}

function matchPlanes(generated, reference, maxDistance = PLANE_EQ_MATCH_TOL) {
    const pairs = [];
    for (let gi = 0; gi < generated.length; gi++) {
        for (let ri = 0; ri < reference.length; ri++) {
            const distance = planeDistance(generated[gi], reference[ri]);
            if (distance <= maxDistance) pairs.push({ gi, ri, distance });
        }
    }
    pairs.sort((left, right) => left.distance - right.distance);

    const usedGenerated = new Set();
    const usedReference = new Set();
    const matched = [];
    for (const pair of pairs) {
        if (usedGenerated.has(pair.gi) || usedReference.has(pair.ri)) continue;
        usedGenerated.add(pair.gi);
        usedReference.add(pair.ri);
        matched.push({
            generated: generated[pair.gi],
            reference: reference[pair.ri],
            distance: pair.distance,
        });
    }

    return {
        matched,
        unmatchedGenerated: generated.filter((_, index) => !usedGenerated.has(index)),
        unmatchedReference: reference.filter((_, index) => !usedReference.has(index)),
    };
}

function buildVertices(parser) {
    const points = parser.extractCoordinates();
    const vertices = points.map((point, index) => ({
        id: index + 1,
        position: {
            x: point.x * PS_TO_MM,
            y: point.y * PS_TO_MM,
            z: point.z * PS_TO_MM,
        },
    }));
    return ParasolidParser.filterOutlierVertices(vertices);
}

function validateExtractedSurfaces(vertices, extractedSurfaces) {
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
            const distance = Math.abs(dx * params.normal.x + dy * params.normal.y + dz * params.normal.z);
            if (distance < VERTEX_PLANE_TOL) coplanar.push(vertex.position);
        }
        if (coplanar.length < 3) continue;
        const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, params.normal);
        if (ratio <= PLANE_EIGEN_RATIO_MAX) validated.push(surface);
    }
    return validated;
}

function collectRawPlaneLikeRecords(parser, vertices) {
    const records = [];
    const entities = parser.extractAllEntities().filter((entity) => entity.type === 0x1e);
    for (const entity of entities) {
        const result = ParasolidParser.readGeomFloats(entity.data);
        if (!result) continue;
        const floats = result.floats;
        if (floats.length !== 7 && floats.length !== 8) continue;

        const normal = normalizeDirection({ x: floats[3], y: floats[4], z: floats[5] });
        if (!normal) continue;

        const origin = {
            x: floats[0] * PS_TO_MM,
            y: floats[1] * PS_TO_MM,
            z: floats[2] * PS_TO_MM,
        };
        const support = [];
        for (const vertex of vertices) {
            const dx = vertex.position.x - origin.x;
            const dy = vertex.position.y - origin.y;
            const dz = vertex.position.z - origin.z;
            const distance = Math.abs(dx * normal.x + dy * normal.y + dz * normal.z);
            if (distance < VERTEX_PLANE_TOL) support.push(vertex.position);
        }

        const ratio = support.length >= 3
            ? ParasolidParser.computeEigenvalueRatio(support, normal)
            : null;
        const state = support.length < 3
            ? 'sparse'
            : ratio !== null && ratio <= PLANE_EIGEN_RATIO_MAX
                ? 'accepted'
                : 'rejected';

        records.push({
            id: entity.id,
            normal,
            supportCount: support.length,
            ratio,
            state,
        });
    }
    return records;
}

function buildManufacturingNormals() {
    const result = [];
    const add = (x, y, z) => {
        const normal = normalizeDirection({ x, y, z });
        if (!normal || isAxisAligned(normal)) return;
        addUniqueNormal(result, normal);
    };

    const values = [
        [1, 1, 0],
        [1, -1, 0],
        [1, 0, 1],
        [1, 0, -1],
        [0, 1, 1],
        [0, 1, -1],
        [0.5, 0.8660254037844386, 0],
        [0.8660254037844386, 0.5, 0],
        [0.5, 0, 0.8660254037844386],
        [0.8660254037844386, 0, 0.5],
        [0, 0.5, 0.8660254037844386],
        [0, 0.8660254037844386, 0.5],
        [1, 1.7320508075688772, 2],
        [1, -1.7320508075688772, 2],
        [1.7320508075688772, 1, 2],
        [1.7320508075688772, -1, 2],
        [1, 2, 1.7320508075688772],
        [1, 2, -1.7320508075688772],
        [2, 1, 1.7320508075688772],
        [2, -1, 1.7320508075688772],
        [2, 1.7320508075688772, 1],
        [2, -1.7320508075688772, 1],
    ];
    for (const [x, y, z] of values) add(x, y, z);
    return result;
}

function collectBaselineNonAxisNormals(validatedSurfaces) {
    const normals = [];
    for (const surface of validatedSurfaces) {
        if (surface.surfaceType !== 'plane') continue;
        const normal = canonicalNormal(surface.params.normal);
        if (isAxisAligned(normal)) continue;
        addUniqueNormal(normals, normal);
    }
    return normals;
}

function inferPlanesWithNormalBank(vertices, existingSurfaces, extraNormals) {
    if (vertices.length < 3) return [];

    const axisNormals = [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
    ];
    const nonAxisNormals = [];
    for (const normal of collectBaselineNonAxisNormals(existingSurfaces)) {
        addUniqueNormal(nonAxisNormals, normal);
    }
    for (const normal of extraNormals) {
        if (!isAxisAligned(normal)) addUniqueNormal(nonAxisNormals, normal);
    }

    const existingPlaneEqs = [];
    for (const surface of existingSurfaces) {
        if (surface.surfaceType !== 'plane') continue;
        const params = surface.params;
        existingPlaneEqs.push({
            normal: canonicalNormal(params.normal),
            d: params.origin.x * params.normal.x + params.origin.y * params.normal.y + params.origin.z * params.normal.z,
        });
    }

    const inferred = [];
    let nextId = existingSurfaces.length + 1000;
    const allNormals = [
        ...axisNormals.map((normal) => ({ normal, minVerts: 3 })),
        ...nonAxisNormals.map((normal) => ({ normal, minVerts: 5 })),
    ];

    for (const { normal, minVerts } of allNormals) {
        const projections = vertices
            .map((vertex, idx) => ({
                idx,
                d: vertex.position.x * normal.x
                    + vertex.position.y * normal.y
                    + vertex.position.z * normal.z,
            }))
            .sort((left, right) => left.d - right.d);

        let cursor = 0;
        while (cursor < projections.length) {
            const start = cursor;
            const d0 = projections[cursor].d;
            while (cursor < projections.length && projections[cursor].d - d0 < INFER_CLUSTER_TOL) cursor++;

            const clusterSize = cursor - start;
            if (clusterSize < minVerts) continue;

            const basis = ParasolidParser.planeBasis(normal);
            let uMin = Infinity;
            let uMax = -Infinity;
            let vMin = Infinity;
            let vMax = -Infinity;
            let dSum = 0;
            for (let index = start; index < cursor; index++) {
                const point = vertices[projections[index].idx].position;
                const u = point.x * basis.uAxis.x + point.y * basis.uAxis.y + point.z * basis.uAxis.z;
                const v = point.x * basis.vAxis.x + point.y * basis.vAxis.y + point.z * basis.vAxis.z;
                if (u < uMin) uMin = u;
                if (u > uMax) uMax = u;
                if (v < vMin) vMin = v;
                if (v > vMax) vMax = v;
                dSum += projections[index].d;
            }
            if ((uMax - uMin) < 1.0 || (vMax - vMin) < 1.0) continue;

            const dAvg = dSum / clusterSize;
            let alreadyExists = false;
            for (const eq of existingPlaneEqs) {
                const dot = eq.normal.x * normal.x + eq.normal.y * normal.y + eq.normal.z * normal.z;
                if (Math.abs(dot) < 0.99) continue;
                const sign = dot > 0 ? 1 : -1;
                if (Math.abs(dAvg - sign * eq.d) < PLANE_EQ_MATCH_TOL) {
                    alreadyExists = true;
                    break;
                }
            }
            if (alreadyExists) continue;

            for (const surface of inferred) {
                const params = surface.params;
                const dot = params.normal.x * normal.x + params.normal.y * normal.y + params.normal.z * normal.z;
                if (Math.abs(dot) < 0.99) continue;
                const infD = params.origin.x * params.normal.x + params.origin.y * params.normal.y + params.origin.z * params.normal.z;
                const sign = dot > 0 ? 1 : -1;
                if (Math.abs(dAvg - sign * infD) < PLANE_EQ_MATCH_TOL) {
                    alreadyExists = true;
                    break;
                }
            }
            if (alreadyExists) continue;

            const planeNormal = dAvg >= 0
                ? { x: normal.x, y: normal.y, z: normal.z }
                : { x: -normal.x, y: -normal.y, z: -normal.z };
            const planeD = Math.abs(dAvg);
            inferred.push({
                id: nextId++,
                surfaceType: 'plane',
                params: {
                    origin: {
                        x: planeNormal.x * planeD,
                        y: planeNormal.y * planeD,
                        z: planeNormal.z * planeD,
                    },
                    normal: planeNormal,
                },
            });
        }
    }

    return inferred;
}

function rebuildWithInferredPlanes(parser, vertices, validatedSurfaces, inferredPlanes) {
    const mergedSurfaces = ParasolidParser.recoverAxisymmetricWasherSurfaces(
        [...validatedSurfaces, ...inferredPlanes],
        vertices,
    );
    const apexCones = parser.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
    const directDrillTipCones = parser.inferDrillTipConesFromRawCylinderSections(
        validatedSurfaces,
        vertices,
        apexCones,
    );
    const halfRadiusDrillTipCones = parser.inferHalfRadiusDrillTipConesFromRawCylinderSections(
        validatedSurfaces,
        vertices,
    );
    const repeatedCenterDrillTipCones = parser.inferRepeatedCenterCylinderDrillTipCones(
        validatedSurfaces,
        vertices,
        halfRadiusDrillTipCones,
    );
    const surfaces = parser.deduplicateSurfaces([
        ...mergedSurfaces,
        ...apexCones,
        ...directDrillTipCones,
        ...halfRadiusDrillTipCones,
        ...repeatedCenterDrillTipCones,
    ]);
    surfaces.forEach((surface, index) => {
        surface.id = index + 1;
    });
    return surfaces.filter((surface) => surface.surfaceType === 'plane').map((surface) => {
        const params = surface.params;
        const normal = canonicalNormal(params.normal);
        return {
            id: surface.id,
            origin: [params.origin.x, params.origin.y, params.origin.z],
            normal,
            d: params.origin.x * params.normal.x + params.origin.y * params.normal.y + params.origin.z * params.normal.z,
        };
    });
}

function summarizeStrategy(name, planes, referencePlanes) {
    const match = matchPlanes(planes, referencePlanes);
    return {
        name,
        generated: planes.length,
        matched: match.matched.length,
        unmatchedGenerated: match.unmatchedGenerated.length,
        unmatchedReference: match.unmatchedReference.length,
        extraGenerated: match.unmatchedGenerated.slice(0, 5).map((plane) => ({
            d: Number(plane.d.toFixed(2)),
            normal: [
                Number(plane.normal.x.toFixed(3)),
                Number(plane.normal.y.toFixed(3)),
                Number(plane.normal.z.toFixed(3)),
            ],
        })),
        missingReference: match.unmatchedReference.slice(0, 5).map((plane) => ({
            d: Number(plane.d.toFixed(2)),
            normal: [
                Number(plane.normal.x.toFixed(3)),
                Number(plane.normal.y.toFixed(3)),
                Number(plane.normal.z.toFixed(3)),
            ],
        })),
    };
}

function analyzeSample(samplePath) {
    const sampleName = path.basename(samplePath);
    const referencePath = resolveReferencePath(sampleName);
    const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
    if (!extraction) {
        throw new Error(`Failed to extract Parasolid payload from ${sampleName}`);
    }

    const parser = new ParasolidParser(extraction.data);
    const vertices = buildVertices(parser);
    const extractedSurfaces = parser.extractSurfaces();
    const validatedSurfaces = validateExtractedSurfaces(vertices, extractedSurfaces);
    const rawPlaneLike = collectRawPlaneLikeRecords(parser, vertices);
    const referencePlanes = extractReferencePlanes(fs.readFileSync(referencePath, 'utf8'));

    const currentInferred = parser.inferPlanesFromVertices(vertices, validatedSurfaces);
    const rawAllNormals = [];
    const rawRejectedNormals = [];
    for (const record of rawPlaneLike) {
        if (isAxisAligned(record.normal)) continue;
        addUniqueNormal(rawAllNormals, record.normal);
        if (record.state === 'rejected') addUniqueNormal(rawRejectedNormals, record.normal);
    }
    const manufacturingNormals = buildManufacturingNormals();

    const strategies = [
        {
            name: 'baseline',
            inferred: currentInferred,
        },
        {
            name: 'fixed_bank',
            inferred: inferPlanesWithNormalBank(vertices, validatedSurfaces, manufacturingNormals),
        },
        {
            name: 'raw_rejected_bank',
            inferred: inferPlanesWithNormalBank(vertices, validatedSurfaces, rawRejectedNormals),
        },
        {
            name: 'fixed_plus_raw_rejected',
            inferred: inferPlanesWithNormalBank(vertices, validatedSurfaces, [...manufacturingNormals, ...rawRejectedNormals]),
        },
        {
            name: 'fixed_plus_raw_all',
            inferred: inferPlanesWithNormalBank(vertices, validatedSurfaces, [...manufacturingNormals, ...rawAllNormals]),
        },
    ];

    return {
        file: sampleName,
        referencePlanes: referencePlanes.length,
        vertices: vertices.length,
        extractedPlaneCount: extractedSurfaces.filter((surface) => surface.surfaceType === 'plane').length,
        validatedPlaneCount: validatedSurfaces.filter((surface) => surface.surfaceType === 'plane').length,
        rawPlaneLike: {
            total: rawPlaneLike.length,
            accepted: rawPlaneLike.filter((record) => record.state === 'accepted').length,
            rejected: rawPlaneLike.filter((record) => record.state === 'rejected').length,
            sparse: rawPlaneLike.filter((record) => record.state === 'sparse').length,
            uniqueNonAxisRejected: rawRejectedNormals.length,
            uniqueNonAxisAll: rawAllNormals.length,
        },
        strategies: strategies.map((strategy) => {
            const planes = rebuildWithInferredPlanes(parser, vertices, validatedSurfaces, strategy.inferred);
            return summarizeStrategy(strategy.name, planes, referencePlanes);
        }),
    };
}

const samplePaths = listSamplePaths();
if (samplePaths.length === 0) {
    throw new Error(`No matching sample files under ${SAMPLE_DIR}`);
}

const reports = samplePaths.map(analyzeSample);
console.log(JSON.stringify({
    sampleCount: reports.length,
    filters: SAMPLE_FILTERS,
    reports,
}, null, 2));