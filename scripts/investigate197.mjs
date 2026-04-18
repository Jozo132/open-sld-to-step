#!/usr/bin/env bun
/**
 * investigate197.mjs — Compare the FTC_07 broad-133 loop against the face on wrapper90's plane.
 *
 * Goal:
 * 1. Resolve the reference ADVANCED_FACE that uses plane #5959, which matches
 *    wrapper 90's decoded frame placement.
 * 2. Extract its ordered outer-loop edges and chord lengths.
 * 3. Compare that 16-edge loop against the 15 decoded broad-133 segments to
 *    test whether the slot-3 branch is carrying almost the full face boundary
 *    with one closure edge still hidden in the endcaps.
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
const TARGET_PLANE_ID = 5959;

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function samePoint(left, right, tol = 0.01) {
    return distance(left, right) <= tol;
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

function resolveFaceOnPlane(entities, planeId) {
    for (const entity of entities.values()) {
        if (!entity.types.includes('ADVANCED_FACE')) continue;
        const refs = extractRefs(entity.args);
        if (refs.includes(planeId)) return entity;
    }
    return null;
}

function resolveOuterLoop(entities, face) {
    const refs = extractRefs(face.args);
    const outerBoundId = refs.find((id) => entities.get(id)?.types.includes('FACE_OUTER_BOUND'));
    if (!outerBoundId) return null;
    const outerBound = entities.get(outerBoundId);
    const outerRefs = extractRefs(outerBound.args);
    const loopId = outerRefs.find((id) => entities.get(id)?.types.includes('EDGE_LOOP'));
    if (!loopId) return null;
    const loop = entities.get(loopId);
    return {
        outerBoundId,
        loopId,
        orientedEdgeIds: extractRefs(loop.args),
    };
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
    const orientation = /\.T\.\s*\)$/i.test(oriented.raw) ? true : /\.F\.\s*\)$/i.test(oriented.raw) ? false : null;
    const orderedStart = orientation === false ? endVertex : startVertex;
    const orderedEnd = orientation === false ? startVertex : endVertex;

    return {
        orientedEdgeId,
        edgeCurveId,
        curveId: edgeRefs[2],
        curveType: curve?.types?.[0] ?? curve?.type ?? '???',
        startVertexId: edgeRefs[0],
        endVertexId: edgeRefs[1],
        orderedStart,
        orderedEnd,
        chordLength: startVertex && endVertex ? distance(startVertex, endVertex) : null,
    };
}

function buildOrderedBroadSegments(parser) {
    const segments = new Map(parser.parseBroadProfileSegmentRecords().map((record) => [record.id, record]));
    const wrappers = parser.parseProfileWrapperRecords().sort((left, right) => left.id - right.id);
    const orderedIds = wrappers
        .map((record) => record.previousSegmentId)
        .filter((id) => id !== null && segments.has(id));
    return orderedIds.map((id) => segments.get(id));
}

function compareSequence(faceEdges, broadSegments) {
    const faceLengths = faceEdges.map((edge) => edge.chordLength ?? Number.NaN);
    const broadLengths = broadSegments.map((segment) => segment.encodedLength);
    let best = null;

    for (let skip = 0; skip < faceLengths.length; skip++) {
        const reducedEdges = faceEdges.filter((_, index) => index !== skip);
        for (const reverse of [false, true]) {
            const faceSeq = reverse ? [...reducedEdges].reverse() : reducedEdges;
            for (let shift = 0; shift < faceSeq.length; shift++) {
                const rotated = faceSeq.slice(shift).concat(faceSeq.slice(0, shift));
                let totalDelta = 0;
                const rows = [];
                for (let index = 0; index < broadLengths.length; index++) {
                    const broadLength = broadLengths[index];
                    const faceLength = rotated[index]?.chordLength ?? Number.NaN;
                    const delta = Math.abs(faceLength - broadLength);
                    totalDelta += delta;
                    rows.push({
                        broadId: broadSegments[index].id,
                        broadLength,
                        faceOrientedEdgeId: rotated[index]?.orientedEdgeId ?? null,
                        faceCurveType: rotated[index]?.curveType ?? '???',
                        faceLength,
                        delta,
                    });
                }
                const candidate = {
                    skipEdgeIndex: skip,
                    skippedOrientedEdgeId: faceEdges[skip]?.orientedEdgeId ?? null,
                    skippedCurveType: faceEdges[skip]?.curveType ?? '???',
                    reverse,
                    shift,
                    totalDelta,
                    rows,
                };
                if (!best || candidate.totalDelta < best.totalDelta) best = candidate;
            }
        }
    }

    return best;
}

const { parser, fileName } = loadSample(SAMPLE_PATH);
const broadSegments = buildOrderedBroadSegments(parser);
const referenceText = fs.readFileSync(REFERENCE_PATH, 'utf8');
const entities = parseStepEntities(referenceText);
const lengthScale = detectLengthUnitScale(referenceText);

const face = resolveFaceOnPlane(entities, TARGET_PLANE_ID);
if (!face) throw new Error(`Could not resolve ADVANCED_FACE using plane #${TARGET_PLANE_ID}`);

const loop = resolveOuterLoop(entities, face);
if (!loop) throw new Error(`Could not resolve outer loop for face #${face.id}`);

const faceEdges = loop.orientedEdgeIds
    .map((id) => resolveOrientedEdge(entities, id, lengthScale))
    .filter((edge) => edge !== null);
const best = compareSequence(faceEdges, broadSegments);

console.log('investigate197 — FTC_07 wrapper90 face vs broad-133 loop');
console.log('Clean-room basis: compare the reference face on plane #5959 against the decoded broad-133 segment chain.');
console.log(`\nfile=${fileName}`);
console.log(`referenceFace=#${face.id} plane=#${TARGET_PLANE_ID} outerLoop=#${loop.loopId}`);
console.log(`broadSegments=${broadSegments.length} faceEdges=${faceEdges.length}`);

console.log('\nBroad segment sequence:');
for (const segment of broadSegments) {
    console.log(`  broad#${segment.id} length=${formatNumber(segment.encodedLength)} p1=${formatPoint(segment.startPoint)} p2=${formatPoint(segment.endPoint)}`);
}

console.log('\nReference face outer loop:');
for (const edge of faceEdges) {
    console.log(`  orientedEdge=#${edge.orientedEdgeId} edgeCurve=#${edge.edgeCurveId} curve=${edge.curveType} length=${formatNumber(edge.chordLength ?? Number.NaN)} start=${edge.orderedStart ? formatPoint(edge.orderedStart) : 'n/a'} end=${edge.orderedEnd ? formatPoint(edge.orderedEnd) : 'n/a'}`);
}

if (best) {
    console.log('\nBest 15-of-16 sequence alignment:');
    console.log(`  skippedOrientedEdge=#${best.skippedOrientedEdgeId} skippedCurve=${best.skippedCurveType} reverse=${best.reverse ? 1 : 0} shift=${best.shift} totalDelta=${formatNumber(best.totalDelta)}`);
    for (const row of best.rows) {
        console.log(`    broad#${row.broadId} len=${formatNumber(row.broadLength)} -> edge#${row.faceOrientedEdgeId} curve=${row.faceCurveType} len=${formatNumber(row.faceLength)} delta=${formatNumber(row.delta)}`);
    }
  }

const orderedVertices = faceEdges.map((edge) => edge.orderedStart).filter((point) => point !== null);
const broadPoints = broadSegments.flatMap((segment) => [segment.startPoint, segment.endPoint]);
const matchedVertices = orderedVertices.filter((vertex) => broadPoints.some((point) => samePoint(vertex, point))).length;
console.log(`\nExact mm-space vertex matches against broad endpoints=${matchedVertices}/${orderedVertices.length}`);