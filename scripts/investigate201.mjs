#!/usr/bin/env bun
/**
 * investigate201.mjs — Search for direct reference geometry matches to wrapper16.
 *
 * Goal:
 * 1. Extract wrapper 16's primary point+tangent row from the integrated parser.
 * 2. Scan reference STEP placements and LINE entities for nearby point/direction matches.
 * 3. Test whether wrapper 16 lands directly on a reference geometric primitive
 *    or remains a local/start-side transition token.
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

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function directionDistance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
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
    return normalize({ x: values[0], y: values[1], z: values[2] });
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

function resolveLine(entities, id, lengthScale) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('LINE')) return null;
    const refs = extractRefs(entity.args);
    return {
        id,
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0], lengthScale) : null,
        direction: refs[1] ? resolveVectorDirection(entities, refs[1]) : null,
    };
}

function resolveVectorDirection(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('VECTOR')) return null;
    const refs = extractRefs(entity.args);
    return refs[0] ? resolveDirection(entities, refs[0]) : null;
}

const { parser, fileName } = loadSample(SAMPLE_PATH);
const wrapper16 = parser.parseProfileWrapperRecords().find((record) => record.id === 16);
if (!wrapper16?.primaryPoint || !wrapper16.primaryDirection) throw new Error('Wrapper 16 primary row missing');

const referenceText = fs.readFileSync(REFERENCE_PATH, 'utf8');
const entities = parseStepEntities(referenceText);
const lengthScale = detectLengthUnitScale(referenceText);

const placementMatches = [...entities.keys()]
    .map((id) => resolveAxis2Placement(entities, id, lengthScale))
    .filter((placement) => placement && placement.origin && placement.axis)
    .map((placement) => ({
        kind: 'placement',
        id: placement.id,
        origin: placement.origin,
        direction: placement.axis,
        pointDelta: distance(placement.origin, wrapper16.primaryPoint),
        dirDelta: directionDistance(placement.axis, wrapper16.primaryDirection),
    }))
    .sort((left, right) => left.pointDelta - right.pointDelta || left.dirDelta - right.dirDelta)
    .slice(0, 10);

const lineMatches = [...entities.keys()]
    .map((id) => resolveLine(entities, id, lengthScale))
    .filter((line) => line && line.origin && line.direction)
    .map((line) => ({
        kind: 'line',
        id: line.id,
        origin: line.origin,
        direction: line.direction,
        pointDelta: distance(line.origin, wrapper16.primaryPoint),
        dirDelta: Math.min(
            directionDistance(line.direction, wrapper16.primaryDirection),
            directionDistance({ x: -line.direction.x, y: -line.direction.y, z: -line.direction.z }, wrapper16.primaryDirection),
        ),
    }))
    .sort((left, right) => left.pointDelta - right.pointDelta || left.dirDelta - right.dirDelta)
    .slice(0, 15);

console.log('investigate201 — FTC_07 wrapper16 direct-geometry search');
console.log('Clean-room basis: search the reference STEP model for direct placement or LINE matches to wrapper16\'s primary row.');
console.log(`\nfile=${fileName}`);
console.log(`wrapper16 point=${formatPoint(wrapper16.primaryPoint)} dir=${formatPoint(wrapper16.primaryDirection)}`);

console.log('\nNearest placements:');
for (const match of placementMatches) {
    console.log(`  placement=#${match.id} origin=${formatPoint(match.origin)} axis=${formatPoint(match.direction)} pointDelta=${formatNumber(match.pointDelta)} dirDelta=${formatNumber(match.dirDelta)}`);
}

console.log('\nNearest lines:');
for (const match of lineMatches) {
    console.log(`  line=#${match.id} origin=${formatPoint(match.origin)} dir=${formatPoint(match.direction)} pointDelta=${formatNumber(match.pointDelta)} dirDelta=${formatNumber(match.dirDelta)}`);
}