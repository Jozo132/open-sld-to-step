#!/usr/bin/env bun
/**
 * investigate204.mjs — Quantify set-wise alignment between broad vertices and rounded-loop skeleton vertices.
 *
 * Goal:
 * 1. Reuse the matched rounded loops for the two broad components.
 * 2. Compute the infinite-line intersection vertices of those loops.
 * 3. Find the best cyclic and reversed alignment in XZ, ignoring Y, so we can
 *    measure whether the broad components are the same skeleton geometry in a
 *    shifted local section plane.
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

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function distance2D(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

function normalize2D(dx, dz) {
    const length = Math.hypot(dx, dz) || 1;
    return { x: dx / length, z: dz / length };
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

function buildOrderedBroadSegments(parser) {
    const segments = new Map(parser.parseBroadProfileSegmentRecords().map((record) => [record.id, record]));
    const wrappers = parser.parseProfileWrapperRecords().sort((left, right) => left.id - right.id);
    const orderedIds = wrappers
        .map((record) => record.previousSegmentId)
        .filter((id) => id !== null && segments.has(id));
    return orderedIds.map((id) => segments.get(id));
}

function buildBroadComponents(orderedSegments) {
    const unused = new Map(orderedSegments.map((segment) => [segment.id, segment]));
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
                if (distance2D(candidate.endPoint, head.startPoint) <= 0.05) {
                    component.unshift(candidate);
                    unused.delete(candidate.id);
                    extended = true;
                    break;
                }
                if (distance2D(tail.endPoint, candidate.startPoint) <= 0.05) {
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

function buildLoopLines(entities, lengthScale, faceId, boundId) {
    const face = entities.get(faceId);
    const refs = extractRefs(face.args);
    if (!refs.includes(boundId)) throw new Error(`Face #${faceId} does not include bound #${boundId}`);
    const bound = entities.get(boundId);
    const loopId = extractRefs(bound.args).find((id) => entities.get(id)?.types.includes('EDGE_LOOP'));
    const loop = entities.get(loopId);
    const edges = extractRefs(loop.args)
        .map((id) => resolveOrientedEdge(entities, id, lengthScale))
        .filter((edge) => edge !== null);
    return edges.filter((edge) => edge.curveType === 'LINE' && edge.direction);
}

function bestAlignment(broadVertices, skeletonVertices) {
    let best = null;
    for (const reverse of [false, true]) {
        const skeleton = reverse ? [...skeletonVertices].reverse() : skeletonVertices;
        for (let shift = 0; shift < skeleton.length; shift++) {
            const rotated = skeleton.slice(shift).concat(skeleton.slice(0, shift));
            let total = 0;
            let max = 0;
            for (let index = 0; index < broadVertices.length; index++) {
                const delta = distance2D(broadVertices[index], rotated[index]);
                total += delta;
                if (delta > max) max = delta;
            }
            const candidate = { reverse, shift, avg: total / broadVertices.length, max, rotated };
            if (!best || candidate.avg < best.avg || (candidate.avg === best.avg && candidate.max < best.max)) best = candidate;
        }
    }
    return best;
}

const targets = new Map([
    ['88,85,82,79,76,73,70,67', { faceId: 7818, boundId: 7799 }],
    ['64,61,58,55,52,49,46', { faceId: 6693, boundId: 6692, skipIndex: 1 }],
]);

const { parser, fileName } = loadSample(SAMPLE_PATH);
const components = buildBroadComponents(buildOrderedBroadSegments(parser));
const entities = parseStepEntities(fs.readFileSync(REFERENCE_PATH, 'utf8'));
const lengthScale = detectLengthUnitScale(fs.readFileSync(REFERENCE_PATH, 'utf8'));

console.log('investigate204 — FTC_07 broad vertex set alignment');
console.log('Clean-room basis: compare broad XZ vertices to the sharp-corner skeleton vertices of matched rounded loops.');
console.log(`\nfile=${fileName}`);

for (const component of components) {
    const key = component.ids.join(',');
    const target = targets.get(key);
    if (!target) continue;
    let lines = buildLoopLines(entities, lengthScale, target.faceId, target.boundId);
    if (typeof target.skipIndex === 'number') lines = lines.filter((_, index) => index !== target.skipIndex);
    const intersections = [];
    for (let index = 0; index < lines.length - 1; index++) intersections.push(intersectLinesXZ(lines[index], lines[index + 1]));
    if (component.segments.length === lines.length) intersections.push(intersectLinesXZ(lines[lines.length - 1], lines[0]));

    const broadVertices = component.segments.map((segment) => segment.startPoint);
    const alignment = bestAlignment(broadVertices, intersections);
    console.log(`\ncomponent ids=[${component.ids.join(', ')}] targetFace=#${target.faceId} targetBound=#${target.boundId}`);
    console.log(`  bestAlignment reverse=${alignment.reverse ? 1 : 0} shift=${alignment.shift} avgXZDelta=${formatNumber(alignment.avg)} maxXZDelta=${formatNumber(alignment.max)}`);
    console.log(`  broadY=${formatNumber(broadVertices[0].y)} targetY=${formatNumber(intersections[0].y)} yShift=${formatNumber(broadVertices[0].y - intersections[0].y)}`);
    for (let index = 0; index < broadVertices.length; index++) {
        const broad = broadVertices[index];
        const targetPoint = alignment.rotated[index];
        console.log(`    broadVertex${index}=${formatPoint(broad)} skeletonVertex=${formatPoint(targetPoint)} xzDelta=${formatNumber(distance2D(broad, targetPoint))}`);
    }
}