#!/usr/bin/env node
/**http://localhost:3000
 *
 * Usage:
 *   node scripts/investigate129.mjs
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

function canonicalizeAxis(axis) {
    const normalized = [...axis];
    for (const component of normalized) {
        if (Math.abs(component) < 1e-9) continue;
        if (component < 0) return normalized.map((value) => -value);
        break;
    }
    return normalized;
}

function canonicalizeCone(origin, axis, radius, semiAngle) {
    const canonicalAxis = canonicalizeAxis(axis);
    const offset = radius / Math.tan(semiAngle);
    return {
        axis: canonicalAxis,
        semiAngle,
        apex: [
            origin[0] - canonicalAxis[0] * offset,
            origin[1] - canonicalAxis[1] * offset,
            origin[2] - canonicalAxis[2] * offset,
        ],
    };
}

function extractFaceVertices(entities, boundIds) {
    const faceVertices = [];
    for (const boundId of boundIds) {
        const bound = entities.get(boundId);
        if (!bound) continue;
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
    return faceVertices;
}

function summarizeFaceVertices(vertices) {
    if (vertices.length < 2) return { centroid: null, bboxDiag: 0, vertexCount: vertices.length };

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;

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
    }

    return {
        centroid: [sumX / vertices.length, sumY / vertices.length, sumZ / vertices.length],
        bboxDiag: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
        vertexCount: vertices.length,
    };
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

        const radius = Number(parts[2]);
        const semiAngle = Number(parts[3]) * planeAngleScale;
        const canonical = canonicalizeCone(placement.origin, placement.axis, radius, semiAngle);
        const innerCount = boundIds.reduce((count, boundId) => {
            const bound = entities.get(boundId);
            return count + (bound?.types.includes('FACE_BOUND') ? 1 : 0);
        }, 0);
        const faceVertices = extractFaceVertices(entities, boundIds);
        const faceSummary = summarizeFaceVertices(faceVertices);

        faces.push({
            id,
            surfaceId,
            boundId: refs[0],
            signature: [
                ...canonical.apex.map((value) => value.toFixed(3)),
                ...canonical.axis.map((value) => value.toFixed(6)),
                semiAngle.toFixed(6),
                radius.toFixed(3),
            ].join('|'),
            faceSignature: [
                ...canonical.apex.map((value) => value.toFixed(3)),
                ...canonical.axis.map((value) => value.toFixed(6)),
                semiAngle.toFixed(6),
                radius.toFixed(3),
                ...(faceSummary.centroid ?? [NaN, NaN, NaN]).map((value) => Number.isFinite(value) ? value.toFixed(3) : 'nan'),
                faceSummary.bboxDiag.toFixed(3),
                String(innerCount),
                String(faceSummary.vertexCount),
            ].join('|'),
        });
    }

    return faces;
}

function summarize(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const faces = extractConicalFaces(text);
    const groups = new Map();
    for (const face of faces) {
        const bucket = groups.get(face.signature) ?? [];
        bucket.push(face);
        groups.set(face.signature, bucket);
    }

    const duplicates = [...groups.entries()]
        .filter(([, bucket]) => bucket.length > 1)
        .sort((left, right) => right[1].length - left[1].length)
        .map(([signature, bucket]) => ({
            signature,
            count: bucket.length,
            samples: bucket.slice(0, 6).map((face) => ({ id: face.id, surfaceId: face.surfaceId, boundId: face.boundId })),
        }));

    const exactFaceGroups = new Map();
    for (const face of faces) {
        const bucket = exactFaceGroups.get(face.faceSignature) ?? [];
        bucket.push(face);
        exactFaceGroups.set(face.faceSignature, bucket);
    }

    const exactDuplicates = [...exactFaceGroups.entries()]
        .filter(([, bucket]) => bucket.length > 1)
        .sort((left, right) => right[1].length - left[1].length)
        .map(([signature, bucket]) => ({
            signature,
            count: bucket.length,
            samples: bucket.slice(0, 6).map((face) => ({ id: face.id, surfaceId: face.surfaceId, boundId: face.boundId })),
        }));

    return {
        file: path.basename(filePath),
        totalConicalFaces: faces.length,
        uniqueSignatures: groups.size,
        duplicateFaceCount: faces.length - groups.size,
        duplicateGroups: duplicates.slice(0, 12),
        uniqueExactFaceSignatures: exactFaceGroups.size,
        exactDuplicateFaceCount: faces.length - exactFaceGroups.size,
        exactDuplicateGroups: exactDuplicates.slice(0, 12),
    };
}

const root = process.cwd();
const files = [
    path.join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions', 'nist_ctc_02_asme1_rc.stp'),
    path.join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions', 'nist_ctc_04_asme1_rd.stp'),
    path.join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions', 'nist_ctc_05_asme1_rd.stp'),
];

console.log(JSON.stringify(files.map(summarize), null, 2));