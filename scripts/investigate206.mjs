#!/usr/bin/env bun
/**
 * investigate206.mjs — Test whether wrapper16 closes the open broad component into a full rounded-loop skeleton.
 *
 * Goal:
 * 1. Build the open broad component from the integrated parser output.
 * 2. Use wrapper16's primary point and tangent as the missing final corner and
 *    short closing segment.
 * 3. Search all 8-line reference loops by sharp-corner intersection vertices to
 *    find the exact completed skeleton match.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSample } from './_payload-gap-lib.mjs';

const ROOT = process.cwd();
const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const REFERENCE_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
    'nist_ftc_07_asme1_rd.stp',
);
const POINT_TOL_MM = 0.05;

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function distance2D(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

function normalize2D(dx, dz) {
    const length = Math.hypot(dx, dz) || 1;
    return { x: dx / length, z: dz / length };
}

function canonicalDirection2D(direction) {
    if (Math.abs(direction.x) < 1e-9 && direction.z < 0) return { x: -direction.x, z: -direction.z };
    if (direction.x < -1e-9) return { x: -direction.x, z: -direction.z };
    return direction;
}

function directionDelta2D(left, right) {
    const a = canonicalDirection2D(left);
    const b = canonicalDirection2D(right);
    return Math.hypot(a.x - b.x, a.z - b.z);
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function extractJoinedData(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return '';
    return normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
}

function parseStepEntities(text) {
    const entities = new Map();
    const joined = extractJoinedData(text);
    const lineRe = /^#(\d+)\s*=\s*(.+);$/gm;
    let match;
    while ((match = lineRe.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complex = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complex) {
            const types = complex[1].split(',').map((value) => value.trim());
            entities.set(id, { id, type: types.sort().join(','), types, args: complex[2], raw: rest });
            continue;
        }
        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) {
            entities.set(id, { id, type: simple[1], types: [simple[1]], args: simple[2], raw: rest });
            continue;
        }
        entities.set(id, { id, type: '???', types: [], args: rest, raw: rest });
    }
    return entities;
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseNumberTuple(text) {
    return text.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
}

function resolveCartesianPoint(entities, id, lengthScale) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('CARTESIAN_POINT')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    const values = parseNumberTuple(match[1]);
    return { x: values[0] * lengthScale, y: values[1] * lengthScale, z: values[2] * lengthScale };
}

function resolveVertexPoint(entities, id, lengthScale) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('VERTEX_POINT')) return null;
    const refs = extractRefs(entity.args);
    return refs[0] ? resolveCartesianPoint(entities, refs[0], lengthScale) : null;
}

function resolveOrientedEdge(entities, orientedEdgeId, lengthScale) {
    const oriented = entities.get(orientedEdgeId);
    if (!oriented || !oriented.types.includes('ORIENTED_EDGE')) return null;
    const refs = extractRefs(oriented.args);
    const edgeCurveId = refs[0];
    const edgeCurve = entities.get(edgeCurveId);
    if (!edgeCurve || !edgeCurve.types.includes('EDGE_CURVE')) return null;
    const edgeRefs = extractRefs(edgeCurve.args);
    const startVertex = resolveVertexPoint(entities, edgeRefs[0], lengthScale);
    const endVertex = resolveVertexPoint(entities, edgeRefs[1], lengthScale);
    const curve = entities.get(edgeRefs[2]);
    const curveType = curve?.types?.[0] ?? curve?.type ?? '???';
    const orientation = /\.T\.\s*\)$/i.test(oriented.raw) ? true : /\.F\.\s*\)$/i.test(oriented.raw) ? false : null;
    const orderedStart = orientation === false ? endVertex : startVertex;
    const orderedEnd = orientation === false ? startVertex : endVertex;
    const direction = orderedStart && orderedEnd
        ? normalize2D(orderedEnd.x - orderedStart.x, orderedEnd.z - orderedStart.z)
        : null;
    return { orientedEdgeId, curveType, startPoint: orderedStart, endPoint: orderedEnd, direction };
}

function buildLoopLines(entities, lengthScale) {
    const loops = [];
    for (const face of entities.values()) {
        if (!face.types.includes('ADVANCED_FACE')) continue;
        const refs = extractRefs(face.args);
        const surfaceId = refs.find((id) => {
            const entity = entities.get(id);
            return entity && entity.types.some((type) => type.endsWith('SURFACE') || type === 'PLANE');
        });
        const surfaceType = surfaceId ? (entities.get(surfaceId)?.types?.[0] ?? entities.get(surfaceId)?.type ?? '???') : '???';
        for (const boundId of refs.filter((id) => {
            const types = entities.get(id)?.types ?? [];
            return types.includes('FACE_OUTER_BOUND') || types.includes('FACE_BOUND');
        })) {
            const bound = entities.get(boundId);
            const boundType = bound.types.includes('FACE_OUTER_BOUND') ? 'outer' : 'inner';
            const loopId = extractRefs(bound.args).find((id) => entities.get(id)?.types.includes('EDGE_LOOP'));
            if (!loopId) continue;
            const loop = entities.get(loopId);
            const edges = extractRefs(loop.args)
                .map((id) => resolveOrientedEdge(entities, id, lengthScale))
                .filter((edge) => edge !== null);
            const lineEdges = edges.filter((edge) => edge.curveType === 'LINE' && edge.direction);
            if (lineEdges.length === 8) {
                loops.push({ faceId: face.id, surfaceId, surfaceType, boundId, boundType, loopId, lineEdges });
            }
        }
    }
    return loops;
}

function intersectLinesXZ(lineA, lineB) {
    const p = lineA.startPoint;
    const r = { x: lineA.endPoint.x - lineA.startPoint.x, z: lineA.endPoint.z - lineA.startPoint.z };
    const q = lineB.startPoint;
    const s = { x: lineB.endPoint.x - lineB.startPoint.x, z: lineB.endPoint.z - lineB.startPoint.z };
    const cross = r.x * s.z - r.z * s.x;
    if (Math.abs(cross) < 1e-9) return null;
    const qp = { x: q.x - p.x, z: q.z - p.z };
    const t = (qp.x * s.z - qp.z * s.x) / cross;
    return { x: p.x + t * r.x, y: lineA.startPoint.y, z: p.z + t * r.z };
}

function buildBroadComponents(segments) {
    const unused = new Map(segments.map((segment) => [segment.id, segment]));
    const components = [];
    while (unused.size > 0) {
        const seed = unused.values().next().value;
        unused.delete(seed.id);
        const component = [seed];
        let extended = true;
        while (extended) {
            extended = false;
            const head = component[0];
            const tail = component[component.length - 1];
            for (const candidate of [...unused.values()]) {
                if (distance(candidate.endPoint, head.startPoint) <= POINT_TOL_MM) {
                    component.unshift(candidate);
                    unused.delete(candidate.id);
                    extended = true;
                    break;
                }
                if (distance(tail.endPoint, candidate.startPoint) <= POINT_TOL_MM) {
                    component.push(candidate);
                    unused.delete(candidate.id);
                    extended = true;
                    break;
                }
            }
        }
        components.push({ ids: component.map((segment) => segment.id), segments: component });
    }
    return components.sort((left, right) => right.segments.length - left.segments.length || left.ids[0] - right.ids[0]);
}

function bestAlignment(vertices, skeletonVertices) {
    let best = null;
    for (const reverse of [false, true]) {
        const skeleton = reverse ? [...skeletonVertices].reverse() : skeletonVertices;
        for (let shift = 0; shift < skeleton.length; shift++) {
            const rotated = skeleton.slice(shift).concat(skeleton.slice(0, shift));
            let total = 0;
            let max = 0;
            for (let index = 0; index < vertices.length; index++) {
                const delta = distance2D(vertices[index], rotated[index]);
                total += delta;
                if (delta > max) max = delta;
            }
            const candidate = { reverse, shift, avg: total / vertices.length, max, rotated };
            if (!best || candidate.avg < best.avg || (candidate.avg === best.avg && candidate.max < best.max)) best = candidate;
        }
    }
    return best;
}

const { parser, fileName } = loadSample(SAMPLE_PATH);
const segments = parser.parseBroadProfileSegmentRecords().map((record) => ({
    ...record,
    direction2D: normalize2D(record.endPoint.x - record.startPoint.x, record.endPoint.z - record.startPoint.z),
}));
const wrappers = parser.parseProfileWrapperRecords();
const wrapper16 = wrappers.find((record) => record.id === 16);
if (!wrapper16?.primaryPoint || !wrapper16.primaryDirection) throw new Error('Wrapper16 primary row missing');

const components = buildBroadComponents(segments);
const open = components.find((component) => component.ids.join(',') === '64,61,58,55,52,49,46');
if (!open) throw new Error('Open component not found');

const missingSegmentStart = wrapper16.primaryPoint;
const missingSegmentEnd = open.segments[0].startPoint;
const missingDirection = normalize2D(missingSegmentEnd.x - missingSegmentStart.x, missingSegmentEnd.z - missingSegmentStart.z);
const wrapperDir2D = normalize2D(wrapper16.primaryDirection.x, wrapper16.primaryDirection.z);
const missingLength = distance(missingSegmentStart, missingSegmentEnd);

const completedVertices = [
    wrapper16.primaryPoint,
    ...open.segments.map((segment) => segment.startPoint),
];

const referenceText = fs.readFileSync(REFERENCE_PATH, 'utf8');
const entities = parseStepEntities(referenceText);
const lengthScale = detectLengthUnitScale(referenceText);
const loops = buildLoopLines(entities, lengthScale);
const ranked = loops.map((loop) => {
    const intersections = [];
    for (let index = 0; index < loop.lineEdges.length; index++) {
        intersections.push(intersectLinesXZ(loop.lineEdges[index], loop.lineEdges[(index + 1) % loop.lineEdges.length]));
    }
    const alignment = bestAlignment(completedVertices, intersections);
    return { loop, intersections, alignment };
}).sort((left, right) => left.alignment.avg - right.alignment.avg || left.alignment.max - right.alignment.max).slice(0, 10);

console.log('investigate206 — FTC_07 wrapper16 closure test');
console.log('Clean-room basis: test whether wrapper16 closes the open broad component into an exact rounded-loop skeleton.');
console.log(`\nfile=${fileName}`);
console.log(`wrapper16 point=${formatPoint(wrapper16.primaryPoint)} dir=${formatPoint(wrapper16.primaryDirection)}`);
console.log(`missingSegment start=${formatPoint(missingSegmentStart)} end=${formatPoint(missingSegmentEnd)} length=${formatNumber(missingLength)} dir2D=(${formatNumber(missingDirection.x)}, ${formatNumber(missingDirection.z)}) wrapperDir2D=(${formatNumber(wrapperDir2D.x)}, ${formatNumber(wrapperDir2D.z)}) dirDelta=${formatNumber(directionDelta2D(missingDirection, wrapperDir2D))}`);
console.log(`completedVertexCount=${completedVertices.length}`);

console.log('\nTop completed-loop matches:');
for (const entry of ranked) {
    const { loop, alignment } = entry;
    console.log(`  face=#${loop.faceId} surfaceType=${loop.surfaceType} ${loop.boundType}Bound=#${loop.boundId} loop=#${loop.loopId} avgXZDelta=${formatNumber(alignment.avg)} maxXZDelta=${formatNumber(alignment.max)} reverse=${alignment.reverse ? 1 : 0} shift=${alignment.shift}`);
    console.log(`    yShift=${formatNumber(completedVertices[0].y - alignment.rotated[0].y)}`);
  }

const best = ranked[0];
console.log('\nBest match vertices:');
for (let index = 0; index < completedVertices.length; index++) {
    console.log(`  broadVertex${index}=${formatPoint(completedVertices[index])} skeletonVertex=${formatPoint(best.alignment.rotated[index])} xzDelta=${formatNumber(distance2D(completedVertices[index], best.alignment.rotated[index]))}`);
}