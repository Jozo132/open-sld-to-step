#!/usr/bin/env node
/**
 * investigate130.mjs — Compare unique generated/reference conical faces after
 * exact-duplicate deduplication and report remaining bound mismatches.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate130.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

function parseStepEntities(text) {
    const entities = new Map();
    const dataSection = text.replace(/\r\n/g, '\n');
    const dataStart = dataSection.indexOf('DATA;');
    const dataEnd = dataSection.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;
    const data = dataSection.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
    const re = /^#(\d+)\s*=\s*(.+);$/gm;

    let match;
    while ((match = re.exec(data)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complexMatch = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complexMatch) {
            const types = complexMatch[1].split(',').map((value) => value.trim());
            entities.set(id, { type: types.sort().join(','), types, args: complexMatch[2] });
            continue;
        }

        const simpleMatch = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simpleMatch) {
            entities.set(id, { type: simpleMatch[1], types: [simpleMatch[1]], args: simpleMatch[2] });
            continue;
        }

        entities.set(id, { type: '???', types: [], args: rest });
    }

    return entities;
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseNumberTuple(str) {
    return str.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
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
    const vector = parseNumberTuple(match[1]);
    const length = Math.hypot(vector[0], vector[1], vector[2]);
    if (length < 1e-15) return vector;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
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

function entitySignature(entity) {
    return [entity.type, ...(entity.types ?? []), entity.args].join(' ');
}

function resolvePlaneAngleMeasureFactor(entities, id, seen = new Set()) {
    if (seen.has(id)) return null;
    seen.add(id);

    const entity = entities.get(id);
    if (!entity) return null;

    const measureMatch = entity.args.match(/PLANE_ANGLE_MEASURE\(\s*([0-9.eE+\-]+)\s*\)/);
    if (measureMatch) return Number(measureMatch[1]);

    for (const ref of extractRefs(entity.args)) {
        const nested = resolvePlaneAngleMeasureFactor(entities, ref, seen);
        if (nested !== null) return nested;
    }

    return null;
}

function resolvePlaneAngleUnitFactor(entities, id) {
    const entity = entities.get(id);
    if (!entity) return null;

    const signature = entitySignature(entity);
    const hasPlaneAngleUnit = entity.types.includes('PLANE_ANGLE_UNIT') || /PLANE_ANGLE_UNIT\s*\(/i.test(signature);
    if (!hasPlaneAngleUnit) return null;

    if ((entity.types.includes('SI_UNIT') || /SI_UNIT\s*\(/i.test(signature)) && /\.RADIAN\./i.test(signature)) {
        return 1;
    }

    if (entity.types.includes('CONVERSION_BASED_UNIT') || /CONVERSION_BASED_UNIT\s*\(/i.test(signature)) {
        for (const ref of extractRefs(entity.args)) {
            const factor = resolvePlaneAngleMeasureFactor(entities, ref);
            if (factor !== null) return factor;
        }
    }

    return null;
}

function detectPlaneAngleUnitScale(entities) {
    for (const [, entity] of entities) {
        const signature = entitySignature(entity);
        if (!entity.types.includes('GLOBAL_UNIT_ASSIGNED_CONTEXT') && !/GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(/i.test(signature)) continue;
        for (const ref of extractRefs(entity.args)) {
            const factor = resolvePlaneAngleUnitFactor(entities, ref);
            if (factor !== null) return factor;
        }
    }

    for (const [id] of entities) {
        const factor = resolvePlaneAngleUnitFactor(entities, id);
        if (factor !== null) return factor;
    }

    return 1;
}

function dist3(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function dirMatch(a, b, tol = 0.01) {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return Math.abs(Math.abs(dot) - 1.0) < tol;
}

function canonicalizeAxis(axis) {
    const normalized = [...axis];
    for (const component of normalized) {
        if (Math.abs(component) < 1e-9) continue;
        if (component < 0) return normalized.map((value) => -value);
        break;
    }
    return normalized;
}

function canonicalizeCone(cone) {
    const axis = canonicalizeAxis(cone.axis);
    const tanSemiAngle = Math.tan(cone.semiAngle);
    const offset = !isFinite(tanSemiAngle) || Math.abs(tanSemiAngle) < 1e-9
        ? 0
        : cone.radius / tanSemiAngle;
    return {
        axis,
        semiAngle: cone.semiAngle,
        apex: [
            cone.origin[0] - axis[0] * offset,
            cone.origin[1] - axis[1] * offset,
            cone.origin[2] - axis[2] * offset,
        ],
    };
}

function coneDist(a, b) {
    const canonicalA = canonicalizeCone(a);
    const canonicalB = canonicalizeCone(b);
    if (!dirMatch(canonicalA.axis, canonicalB.axis, 0.02)) return Infinity;
    if (Math.abs(canonicalA.semiAngle - canonicalB.semiAngle) > 0.05) return Infinity;
    return dist3(canonicalA.apex, canonicalB.apex);
}

function faceDist(a, b) {
    if (a.surfType !== b.surfType) return Infinity;
    const holePenalty = Math.abs(a.innerCount - b.innerCount) * 10;
    const centroidDist = a.centroid && b.centroid ? dist3(a.centroid, b.centroid) : 50;
    let geomDist = 0;
    if (a.surfGeom && b.surfGeom) {
        geomDist = coneDist(a.surfGeom, b.surfGeom);
        if (!isFinite(geomDist) || geomDist > 2.0) return Infinity;
    }
    return centroidDist + holePenalty + geomDist;
}

function greedyMatch(genArr, refArr, distFn, maxDist) {
    const candidates = [];
    for (let gi = 0; gi < genArr.length; gi++) {
        for (let ri = 0; ri < refArr.length; ri++) {
            const d = distFn(genArr[gi], refArr[ri]);
            if (d <= maxDist) candidates.push({ gi, ri, d });
        }
    }
    candidates.sort((a, b) => a.d - b.d);

    const usedGen = new Set();
    const usedRef = new Set();
    const matched = [];
    for (const candidate of candidates) {
        if (usedGen.has(candidate.gi) || usedRef.has(candidate.ri)) continue;
        usedGen.add(candidate.gi);
        usedRef.add(candidate.ri);
        matched.push({ gen: genArr[candidate.gi], ref: refArr[candidate.ri], dist: candidate.d });
    }

    return {
        matched,
        unmatchedGen: genArr.filter((_, index) => !usedGen.has(index)),
        unmatchedRef: refArr.filter((_, index) => !usedRef.has(index)),
    };
}

function deduplicateByKey(items, keyFn) {
    const seen = new Set();
    const unique = [];
    for (const item of items) {
        const key = keyFn(item);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique;
}

function formatNumber(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'nan';
}

function conicalFaceKey(face) {
    const canonical = canonicalizeCone(face.surfGeom);
    const centroid = face.centroid ?? [NaN, NaN, NaN];
    return [
        ...canonical.apex.map((value) => formatNumber(value, 3)),
        ...canonical.axis.map((value) => formatNumber(value, 6)),
        formatNumber(face.surfGeom.semiAngle, 6),
        formatNumber(face.surfGeom.radius, 3),
        ...centroid.map((value) => formatNumber(value, 3)),
        formatNumber(face.bboxDiag, 3),
        String(face.innerCount),
        String(face.outerCount),
        String(face.vertexCount),
    ].join('|');
}

function uniquePointKey(point) {
    return point.map((value) => formatNumber(value, 4)).join('|');
}

function summarizeFaceVertices(vertices) {
    if (vertices.length === 0) {
        return { centroid: null, bboxDiag: 0, vertexCount: 0, uniqueVertices: [] };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    const uniqueVertices = [];
    const seen = new Set();

    for (const vertex of vertices) {
        minX = Math.min(minX, vertex[0]);
        maxX = Math.max(maxX, vertex[0]);
        minY = Math.min(minY, vertex[1]);
        maxY = Math.max(maxY, vertex[1]);
        minZ = Math.min(minZ, vertex[2]);
        maxZ = Math.max(maxZ, vertex[2]);
        sumX += vertex[0];
        sumY += vertex[1];
        sumZ += vertex[2];

        const key = uniquePointKey(vertex);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueVertices.push(vertex);
    }

    return {
        centroid: [sumX / vertices.length, sumY / vertices.length, sumZ / vertices.length],
        bboxDiag: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
        vertexCount: vertices.length,
        uniqueVertices,
    };
}

function summarizeConeBounds(faceVertices, surfGeom) {
    if (faceVertices.length === 0) {
        return { hMin: NaN, hMax: NaN, rMin: NaN, rMax: NaN, uniqueVertexCount: 0 };
    }

    const canonical = canonicalizeCone(surfGeom);
    let hMin = Infinity;
    let hMax = -Infinity;
    let rMin = Infinity;
    let rMax = -Infinity;

    for (const vertex of faceVertices) {
        const dx = vertex[0] - canonical.apex[0];
        const dy = vertex[1] - canonical.apex[1];
        const dz = vertex[2] - canonical.apex[2];
        const h = dx * canonical.axis[0] + dy * canonical.axis[1] + dz * canonical.axis[2];
        const perpSq = dx * dx + dy * dy + dz * dz - h * h;
        const r = Math.sqrt(Math.max(0, perpSq));
        hMin = Math.min(hMin, h);
        hMax = Math.max(hMax, h);
        rMin = Math.min(rMin, r);
        rMax = Math.max(rMax, r);
    }

    return { hMin, hMax, rMin, rMax, uniqueVertexCount: faceVertices.length };
}

function extractConicalFaces(text) {
    const entities = parseStepEntities(text);
    const planeAngleScale = detectPlaneAngleUnitScale(entities);
    const faces = [];

    for (const [id, entity] of entities) {
        if (!entity.types.includes('ADVANCED_FACE')) continue;
        const boundMatch = entity.args.match(/\(([^)]*)\)/);
        const boundIds = boundMatch ? extractRefs(boundMatch[1]) : [];
        const refs = extractRefs(entity.args);
        const surfaceId = refs.at(-1);
        const surface = surfaceId ? entities.get(surfaceId) : null;
        if (!surface?.types.includes('CONICAL_SURFACE')) continue;

        const parts = surface.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
        if (!parts) continue;
        const placement = resolveAxis2Placement(entities, Number(parts[1]));
        if (!placement?.origin || !placement?.axis) continue;

        const surfGeom = {
            origin: placement.origin,
            axis: placement.axis,
            radius: Number(parts[2]),
            semiAngle: Number(parts[3]) * planeAngleScale,
        };

        const faceVertices = [];
        let outerCount = 0;
        let innerCount = 0;
        for (const boundId of boundIds) {
            const bound = entities.get(boundId);
            if (!bound) continue;
            if (bound.types.includes('FACE_OUTER_BOUND')) outerCount++;
            else if (bound.types.includes('FACE_BOUND')) innerCount++;

            const loopId = extractRefs(bound.args)[0];
            const loop = loopId ? entities.get(loopId) : null;
            if (!loop?.types.includes('EDGE_LOOP')) continue;
            const orientedEdgeIds = extractRefs(loop.args);
            for (const orientedEdgeId of orientedEdgeIds) {
                const orientedEdge = entities.get(orientedEdgeId);
                if (!orientedEdge?.types.includes('ORIENTED_EDGE')) continue;
                const orientedEdgeRefs = extractRefs(orientedEdge.args);
                const edgeCurveId = orientedEdgeRefs.at(-1);
                const edgeCurve = edgeCurveId ? entities.get(edgeCurveId) : null;
                if (!edgeCurve?.types.includes('EDGE_CURVE')) continue;
                const edgeCurveRefs = extractRefs(edgeCurve.args);
                for (const vertexId of edgeCurveRefs.slice(0, 2)) {
                    const vertex = entities.get(vertexId);
                    if (!vertex?.types.includes('VERTEX_POINT')) continue;
                    const pointId = extractRefs(vertex.args)[0];
                    const point = pointId ? resolveCartesianPoint(entities, pointId) : null;
                    if (point) faceVertices.push(point);
                }
            }
        }

        const faceSummary = summarizeFaceVertices(faceVertices);
        const uniqueVertices = faceSummary.uniqueVertices;
        const coneBounds = summarizeConeBounds(uniqueVertices, surfGeom);

        faces.push({
            id,
            surfType: 'CONICAL_SURFACE',
            innerCount,
            outerCount,
            bboxDiag: faceSummary.bboxDiag,
            centroid: faceSummary.centroid,
            vertexCount: faceSummary.vertexCount,
            uniqueVertexCount: uniqueVertices.length,
            surfGeom,
            coneBounds,
        });
    }

    return deduplicateByKey(faces, conicalFaceKey);
}

function summarizeFace(face) {
    const canonical = canonicalizeCone(face.surfGeom);
    return {
        id: face.id,
        apex: canonical.apex.map((value) => Number(formatNumber(value, 3))),
        axis: canonical.axis.map((value) => Number(formatNumber(value, 6))),
        semiAngle: Number(formatNumber(face.surfGeom.semiAngle, 6)),
        radius: Number(formatNumber(face.surfGeom.radius, 3)),
        centroid: face.centroid ? face.centroid.map((value) => Number(formatNumber(value, 3))) : null,
        bboxDiag: Number(formatNumber(face.bboxDiag, 3)),
        innerCount: face.innerCount,
        outerCount: face.outerCount,
        vertexCount: face.vertexCount,
        uniqueVertexCount: face.uniqueVertexCount,
        bounds: {
            hMin: Number(formatNumber(face.coneBounds.hMin, 3)),
            hMax: Number(formatNumber(face.coneBounds.hMax, 3)),
            rMin: Number(formatNumber(face.coneBounds.rMin, 3)),
            rMax: Number(formatNumber(face.coneBounds.rMax, 3)),
        },
    };
}

function analyzePair(genPath, refPath) {
    const generated = extractConicalFaces(fs.readFileSync(genPath, 'utf8'));
    const reference = extractConicalFaces(fs.readFileSync(refPath, 'utf8'));

    const geomMatch = greedyMatch(generated, reference, (gen, ref) => coneDist(gen.surfGeom, ref.surfGeom), 5.0);
    const faceMatch = greedyMatch(generated, reference, faceDist, 200);

    const faceMatchedRefIds = new Set(faceMatch.matched.map((pair) => pair.ref.id));
    const geomByRefId = new Map(geomMatch.matched.map((pair) => [pair.ref.id, pair]));

    const boundMismatches = faceMatch.unmatchedRef
        .filter((ref) => geomByRefId.has(ref.id))
        .map((ref) => {
            const pair = geomByRefId.get(ref.id);
            const gen = pair.gen;
            return {
                geometryDistance: Number(formatNumber(pair.dist, 3)),
                faceDistance: Number(formatNumber(faceDist(gen, ref), 3)),
                centroidDistance: Number(formatNumber(dist3(gen.centroid, ref.centroid), 3)),
                bboxDelta: Number(formatNumber(Math.abs(gen.bboxDiag - ref.bboxDiag), 3)),
                innerDelta: gen.innerCount - ref.innerCount,
                generated: summarizeFace(gen),
                reference: summarizeFace(ref),
            };
        })
        .sort((left, right) => right.faceDistance - left.faceDistance);

    const missingGeometry = faceMatch.unmatchedRef
        .filter((ref) => !geomByRefId.has(ref.id))
        .map((ref) => summarizeFace(ref));

    return {
        file: path.basename(genPath),
        generatedUniqueConicalFaces: generated.length,
        referenceUniqueConicalFaces: reference.length,
        geometryMatchedFaces: geomMatch.matched.length,
        faceMatchedFaces: faceMatch.matched.length,
        geometryMatchedButFaceUnmatched: boundMismatches.length,
        missingGeometryFaces: missingGeometry.length,
        sampleBoundMismatches: boundMismatches.slice(0, 12),
        sampleMissingGeometryFaces: missingGeometry.slice(0, 8),
        sampleFaceMatches: faceMatch.matched
            .filter((pair) => pair.ref.surfType === 'CONICAL_SURFACE' && faceMatchedRefIds.has(pair.ref.id))
            .slice(0, 5)
            .map((pair) => ({
                generated: summarizeFace(pair.gen),
                reference: summarizeFace(pair.ref),
                faceDistance: Number(formatNumber(pair.dist, 3)),
            })),
    };
}

const root = process.cwd();
const pairs = [
    {
        gen: path.join(root, 'output', 'nist_ctc_04_asme1_rd_sw1802.stp'),
        ref: path.join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions', 'nist_ctc_04_asme1_rd.stp'),
    },
    {
        gen: path.join(root, 'output', 'nist_ctc_05_asme1_rd_sw1802.stp'),
        ref: path.join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions', 'nist_ctc_05_asme1_rd.stp'),
    },
];

console.log(JSON.stringify(pairs.map(({ gen, ref }) => analyzePair(gen, ref)), null, 2));