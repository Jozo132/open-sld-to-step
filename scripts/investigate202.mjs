#!/usr/bin/env bun
/**
 * investigate202.mjs — Test whether FTC_07 broad-133 components look like fillet-center offsets.
 *
 * Goal:
 * 1. Split the decoded broad-133 family into connected components by endpoint continuity.
 * 2. Reduce reference face loops to their LINE edges only, preserving order.
 * 3. Find the best line-only loop match for each broad component, allowing one
 *    missing line for the open component.
 * 4. Measure whether the matched broad component is a near-constant offset of
 *    that line network in the XZ plane, which would support a fillet-face or
 *    fillet-center interpretation.
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
const POINT_TOL_MM = 0.01;

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

function samePoint(left, right, tol = POINT_TOL_MM) {
    return distance(left, right) <= tol;
}

function normalize2D(dx, dz) {
    const length = Math.hypot(dx, dz) || 1;
    return { x: dx / length, z: dz / length };
}

function canonicalDirection2D(direction) {
    if (Math.abs(direction.x) < 1e-9 && direction.z < 0) {
        return { x: -direction.x, z: -direction.z };
    }
    if (direction.x < -1e-9) {
        return { x: -direction.x, z: -direction.z };
    }
    return direction;
}

function directionDelta2D(left, right) {
    const a = canonicalDirection2D(left);
    const b = canonicalDirection2D(right);
    return Math.hypot(a.x - b.x, a.z - b.z);
}

function signedOffsetXZ(segment, refLine) {
    const dir = refLine.direction;
    const normal = { x: -dir.z, z: dir.x };
    const dx = segment.startPoint.x - refLine.startPoint.x;
    const dz = segment.startPoint.z - refLine.startPoint.z;
    return dx * normal.x + dz * normal.z;
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
    return {
        orientedEdgeId,
        curveType,
        startPoint: orderedStart,
        endPoint: orderedEnd,
        direction,
        chordLength: orderedStart && orderedEnd ? distance2D(orderedStart, orderedEnd) : Number.NaN,
    };
}

function buildOrderedBroadSegments(parser) {
    const segments = new Map(parser.parseBroadProfileSegmentRecords().map((record) => [record.id, record]));
    const wrappers = parser.parseProfileWrapperRecords().sort((left, right) => left.id - right.id);
    const orderedIds = wrappers
        .map((record) => record.previousSegmentId)
        .filter((id) => id !== null && segments.has(id));
    return orderedIds.map((id) => {
        const record = segments.get(id);
        return {
            ...record,
            direction: normalize2D(record.endPoint.x - record.startPoint.x, record.endPoint.z - record.startPoint.z),
            chordLength2D: distance2D(record.startPoint, record.endPoint),
        };
    });
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
                if (samePoint(candidate.endPoint, head.startPoint)) {
                    component.unshift(candidate);
                    unused.delete(candidate.id);
                    extended = true;
                    break;
                }
                if (samePoint(tail.endPoint, candidate.startPoint)) {
                    component.push(candidate);
                    unused.delete(candidate.id);
                    extended = true;
                    break;
                }
            }
        }

        const closed = component.length > 1 && samePoint(component[component.length - 1].endPoint, component[0].startPoint);
        components.push({
            ids: component.map((segment) => segment.id),
            segments: component,
            closed,
        });
    }

    return components.sort((left, right) => right.segments.length - left.segments.length || left.ids[0] - right.ids[0]);
}

function buildLoopCandidates(entities, lengthScale) {
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
            if (lineEdges.length === 0) continue;
            loops.push({
                faceId: face.id,
                surfaceId,
                surfaceType,
                boundId,
                boundType,
                loopId,
                edges,
                lineEdges,
            });
        }
    }
    return loops;
}

function scoreComponentAgainstLoop(component, loop) {
    const broadSeq = component.segments;
    const lineSeq = loop.lineEdges;
    if (!(lineSeq.length === broadSeq.length || lineSeq.length === broadSeq.length + 1 || lineSeq.length + 1 === broadSeq.length)) {
        return null;
    }

    const broadVariants = [];
    if (broadSeq.length === lineSeq.length) {
        broadVariants.push({ label: 'full', seq: broadSeq });
    } else if (broadSeq.length === lineSeq.length + 1) {
        for (let skip = 0; skip < broadSeq.length; skip++) {
            broadVariants.push({ label: `skipBroad:${skip}`, seq: broadSeq.filter((_, index) => index !== skip) });
        }
    }

    const lineVariants = [];
    if (lineSeq.length === broadSeq.length) {
        lineVariants.push({ label: 'full', seq: lineSeq });
    } else if (lineSeq.length === broadSeq.length + 1) {
        for (let skip = 0; skip < lineSeq.length; skip++) {
            lineVariants.push({ label: `skipLine:${skip}`, seq: lineSeq.filter((_, index) => index !== skip) });
        }
    }

    let best = null;
    for (const broadVariant of broadVariants.length > 0 ? broadVariants : [{ label: 'full', seq: broadSeq }]) {
        for (const lineVariant of lineVariants.length > 0 ? lineVariants : [{ label: 'full', seq: lineSeq }]) {
            for (const reverse of [false, true]) {
                const lines = reverse ? [...lineVariant.seq].reverse() : lineVariant.seq;
                for (let shift = 0; shift < lines.length; shift++) {
                    const rotated = lines.slice(shift).concat(lines.slice(0, shift));
                    let lengthDelta = 0;
                    let directionDelta = 0;
                    const offsets = [];
                    const pairs = [];
                    for (let index = 0; index < Math.min(broadVariant.seq.length, rotated.length); index++) {
                        const broad = broadVariant.seq[index];
                        const line = rotated[index];
                        const lenDelta = broad.chordLength2D - line.chordLength;
                        const dirDelta = directionDelta2D(broad.direction, line.direction);
                        const offset = signedOffsetXZ(broad, line);
                        lengthDelta += Math.abs(lenDelta);
                        directionDelta += dirDelta;
                        offsets.push(offset);
                        pairs.push({ broad, line, lenDelta, dirDelta, offset });
                    }
                    const meanOffset = offsets.reduce((sum, value) => sum + value, 0) / Math.max(offsets.length, 1);
                    const offsetSpread = Math.sqrt(offsets.reduce((sum, value) => sum + (value - meanOffset) ** 2, 0) / Math.max(offsets.length, 1));
                    const score = lengthDelta + directionDelta * 100 + offsetSpread * 50;
                    const candidate = {
                        broadVariant: broadVariant.label,
                        lineVariant: lineVariant.label,
                        reverse,
                        shift,
                        lengthDelta,
                        directionDelta,
                        meanOffset,
                        offsetSpread,
                        score,
                        pairs,
                    };
                    if (!best || candidate.score < best.score) best = candidate;
                }
            }
        }
    }

    return best;
}

const { parser, fileName } = loadSample(SAMPLE_PATH);
const broadComponents = buildBroadComponents(buildOrderedBroadSegments(parser));
const referenceText = fs.readFileSync(REFERENCE_PATH, 'utf8');
const entities = parseStepEntities(referenceText);
const lengthScale = detectLengthUnitScale(referenceText);
const loops = buildLoopCandidates(entities, lengthScale);

console.log('investigate202 — FTC_07 fillet-offset test');
console.log('Clean-room basis: compare broad-133 components to line-only reference loops and test for near-constant XZ offsets.');
console.log(`\nfile=${fileName} components=${broadComponents.length}`);

for (const component of broadComponents) {
    console.log(`\ncomponent ids=[${component.ids.join(', ')}] count=${component.segments.length} closed=${component.closed ? 1 : 0}`);
    console.log('  lengths=' + component.segments.map((segment) => formatNumber(segment.chordLength2D)).join(', '));

    const ranked = loops
        .map((loop) => ({ loop, match: scoreComponentAgainstLoop(component, loop) }))
        .filter((entry) => entry.match !== null)
        .sort((left, right) => left.match.score - right.match.score)
        .slice(0, 5);

    for (const entry of ranked) {
        const { loop, match } = entry;
        console.log(`  match face=#${loop.faceId} surfaceType=${loop.surfaceType} ${loop.boundType}Bound=#${loop.boundId} loop=#${loop.loopId} lineEdges=${loop.lineEdges.length} score=${formatNumber(match.score)} meanOffset=${formatNumber(match.meanOffset)} offsetSpread=${formatNumber(match.offsetSpread)} lengthDelta=${formatNumber(match.lengthDelta)} directionDelta=${formatNumber(match.directionDelta)}`);
        console.log(`    variants broad=${match.broadVariant} line=${match.lineVariant} reverse=${match.reverse ? 1 : 0} shift=${match.shift}`);
        for (const pair of match.pairs.slice(0, 8)) {
            console.log(`    broad#${pair.broad.id} len=${formatNumber(pair.broad.chordLength2D)} -> edge#${pair.line.orientedEdgeId} len=${formatNumber(pair.line.chordLength)} curve=${pair.line.curveType} lenDelta=${formatNumber(pair.lenDelta)} offset=${formatNumber(pair.offset)} dirDelta=${formatNumber(pair.dirDelta)}`);
        }
    }
}