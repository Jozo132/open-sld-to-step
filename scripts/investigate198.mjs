#!/usr/bin/env bun
/**
 * investigate198.mjs — Search the FTC_07 reference STEP for a planar face matching the broad-133 loop.
 *
 * Goal:
 * 1. Decode the ordered broad-133 segment sequence from the FTC_07 slot-3 branch.
 * 2. Scan every planar ADVANCED_FACE in the reference STEP file.
 * 3. Rank faces by how closely their outer-loop chord-length signature matches
 *    the broad-133 sequence, allowing for one missing or extra edge.
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

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
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

function resolveDirection(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('DIRECTION')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    const values = parseNumberTuple(match[1]);
    const length = Math.hypot(values[0], values[1], values[2]) || 1;
    return { x: values[0] / length, y: values[1] / length, z: values[2] / length };
}

function resolveAxis2Placement(entities, id, lengthScale) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('AXIS2_PLACEMENT_3D')) return null;
    const refs = extractRefs(entity.args);
    return {
        id,
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0], lengthScale) : null,
        axis: refs[1] ? resolveDirection(entities, refs[1]) : null,
        refdir: refs[2] ? resolveDirection(entities, refs[2]) : null,
    };
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
    const orientation = /\.T\.\s*\)$/i.test(oriented.raw) ? true : /\.F\.\s*\)$/i.test(oriented.raw) ? false : null;
    const orderedStart = orientation === false ? endVertex : startVertex;
    const orderedEnd = orientation === false ? startVertex : endVertex;
    return {
        orientedEdgeId,
        edgeCurveId,
        curveType: curve?.types?.[0] ?? curve?.type ?? '???',
        orderedStart,
        orderedEnd,
        chordLength: startVertex && endVertex ? distance(startVertex, endVertex) : Number.NaN,
    };
}

function resolvePlaneFaceOuterLoop(entities, face, lengthScale) {
    const refs = extractRefs(face.args);
    const planeId = refs.find((id) => entities.get(id)?.types.includes('PLANE'));
    if (!planeId) return null;
    const plane = entities.get(planeId);
    const planeRefs = extractRefs(plane.args);
    const placement = planeRefs[0] ? resolveAxis2Placement(entities, planeRefs[0], lengthScale) : null;

    const outerBoundId = refs.find((id) => entities.get(id)?.types.includes('FACE_OUTER_BOUND'));
    if (!outerBoundId) return null;
    const outerBound = entities.get(outerBoundId);
    const loopRefs = extractRefs(outerBound.args);
    const loopId = loopRefs.find((id) => entities.get(id)?.types.includes('EDGE_LOOP'));
    if (!loopId) return null;

    const loop = entities.get(loopId);
    const faceEdges = extractRefs(loop.args)
        .map((id) => resolveOrientedEdge(entities, id, lengthScale))
        .filter((edge) => edge !== null);

    return {
        faceId: face.id,
        planeId,
        placement,
        loopId,
        edgeCount: faceEdges.length,
        faceEdges,
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

function scoreFaceAgainstBroad(faceEdges, broadSegments) {
    const broadLengths = broadSegments.map((segment) => segment.encodedLength);
    if (faceEdges.length < broadLengths.length - 1 || faceEdges.length > broadLengths.length + 1) return null;

    const tryAlign = (faceSeq, broadSeq) => {
        let totalDelta = 0;
        for (let index = 0; index < Math.min(faceSeq.length, broadSeq.length); index++) {
            totalDelta += Math.abs(faceSeq[index].chordLength - broadSeq[index]);
        }
        totalDelta += Math.abs(faceSeq.length - broadSeq.length) * 1000;
        return totalDelta;
    };

    let best = Infinity;
    const faceVariants = [];
    if (faceEdges.length === broadLengths.length) {
        faceVariants.push(faceEdges);
    } else if (faceEdges.length === broadLengths.length + 1) {
        for (let skip = 0; skip < faceEdges.length; skip++) {
            faceVariants.push(faceEdges.filter((_, index) => index !== skip));
        }
    } else if (faceEdges.length + 1 === broadLengths.length) {
        for (let skip = 0; skip < broadLengths.length; skip++) {
            const reduced = broadLengths.filter((_, index) => index !== skip);
            for (const reverse of [false, true]) {
                const broadSeq = reverse ? [...reduced].reverse() : reduced;
                for (let shift = 0; shift < broadSeq.length; shift++) {
                    const rotated = broadSeq.slice(shift).concat(broadSeq.slice(0, shift));
                    best = Math.min(best, tryAlign(faceEdges, rotated));
                }
            }
        }
        return best;
    }

    for (const variant of faceVariants) {
        for (const reverse of [false, true]) {
            const orderedFace = reverse ? [...variant].reverse() : variant;
            for (let faceShift = 0; faceShift < orderedFace.length; faceShift++) {
                const rotatedFace = orderedFace.slice(faceShift).concat(orderedFace.slice(0, faceShift));
                for (const broadReverse of [false, true]) {
                    const broadSeq = broadReverse ? [...broadLengths].reverse() : broadLengths;
                    for (let broadShift = 0; broadShift < broadSeq.length; broadShift++) {
                        const rotatedBroad = broadSeq.slice(broadShift).concat(broadSeq.slice(0, broadShift));
                        best = Math.min(best, tryAlign(rotatedFace, rotatedBroad));
                    }
                }
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

const planeFaces = [...entities.values()]
    .filter((entity) => entity.types.includes('ADVANCED_FACE'))
    .map((face) => resolvePlaneFaceOuterLoop(entities, face, lengthScale))
    .filter((face) => face !== null)
    .sort((left, right) => left.faceId - right.faceId);

const ranked = planeFaces
    .map((face) => ({
        ...face,
        score: scoreFaceAgainstBroad(face.faceEdges, broadSegments),
    }))
    .filter((face) => face.score !== null)
    .sort((left, right) => left.score - right.score)
    .slice(0, 20);

console.log('investigate198 — FTC_07 broad-133 face search');
console.log('Clean-room basis: rank reference planar faces by outer-loop similarity to the decoded broad-133 sequence.');
console.log(`\nfile=${fileName} broadSegments=${broadSegments.length}`);
console.log('broadLengths=' + broadSegments.map((segment) => formatNumber(segment.encodedLength)).join(', '));

console.log('\nTop planar face matches:');
for (const face of ranked) {
    const placement = face.placement;
    const origin = placement?.origin
        ? `(${formatNumber(placement.origin.x)}, ${formatNumber(placement.origin.y)}, ${formatNumber(placement.origin.z)})`
        : 'n/a';
    const axis = placement?.axis
        ? `(${formatNumber(placement.axis.x)}, ${formatNumber(placement.axis.y)}, ${formatNumber(placement.axis.z)})`
        : 'n/a';
    const edgeSummary = face.faceEdges.map((edge) => `${edge.curveType}:${formatNumber(edge.chordLength)}`).join(' | ');
    console.log(`  face=#${face.faceId} plane=#${face.planeId} loop=#${face.loopId} edges=${face.edgeCount} score=${formatNumber(face.score)} origin=${origin} axis=${axis}`);
    console.log(`    ${edgeSummary}`);
}