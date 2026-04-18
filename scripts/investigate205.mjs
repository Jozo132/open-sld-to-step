#!/usr/bin/env bun
/**
 * investigate205.mjs — Inspect what surface families sit across the rounded edges matched to broad-133.
 *
 * Goal:
 * 1. Take the rounded loops matched to the broad components.
 * 2. For each non-LINE edge on those loops, find the adjacent face on the other side.
 * 3. Report the neighboring surface types to test whether these rounded edges are
 *    actual fillet faces or some other family such as the shallow cones.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REFERENCE_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
    'nist_ftc_07_asme1_rd.stp',
);

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

function findSurfaceRef(face, entities) {
    return extractRefs(face.args).find((id) => {
        const entity = entities.get(id);
        return entity && entity.types.some((type) => type.endsWith('SURFACE') || type === 'PLANE');
    });
}

function buildBoundEdges(entities, faceId, boundId) {
    const face = entities.get(faceId);
    const refs = extractRefs(face.args);
    if (!refs.includes(boundId)) throw new Error(`Face #${faceId} does not include bound #${boundId}`);
    const bound = entities.get(boundId);
    const loopId = extractRefs(bound.args).find((id) => entities.get(id)?.types.includes('EDGE_LOOP'));
    const loop = entities.get(loopId);
    return extractRefs(loop.args).map((orientedEdgeId) => {
        const oriented = entities.get(orientedEdgeId);
        const edgeCurveId = extractRefs(oriented.args)[0];
        const edgeCurve = entities.get(edgeCurveId);
        const curveId = extractRefs(edgeCurve.args)[2];
        const curve = entities.get(curveId);
        return {
            orientedEdgeId,
            edgeCurveId,
            curveId,
            curveType: curve?.types?.[0] ?? curve?.type ?? '???',
        };
    });
}

function buildEdgeCurveUsers(entities) {
    const users = new Map();
    for (const face of entities.values()) {
        if (!face.types.includes('ADVANCED_FACE')) continue;
        const surfaceId = findSurfaceRef(face, entities);
        const surfaceType = surfaceId ? (entities.get(surfaceId)?.types?.[0] ?? entities.get(surfaceId)?.type ?? '???') : '???';
        const boundIds = extractRefs(face.args).filter((id) => {
            const types = entities.get(id)?.types ?? [];
            return types.includes('FACE_OUTER_BOUND') || types.includes('FACE_BOUND');
        });
        for (const boundId of boundIds) {
            const bound = entities.get(boundId);
            const loopId = extractRefs(bound.args).find((id) => entities.get(id)?.types.includes('EDGE_LOOP'));
            if (!loopId) continue;
            const loop = entities.get(loopId);
            for (const orientedEdgeId of extractRefs(loop.args)) {
                const oriented = entities.get(orientedEdgeId);
                const edgeCurveId = extractRefs(oriented.args)[0];
                const bucket = users.get(edgeCurveId) ?? [];
                bucket.push({ faceId: face.id, boundId, orientedEdgeId, surfaceId, surfaceType });
                users.set(edgeCurveId, bucket);
            }
        }
    }
    return users;
}

const text = fs.readFileSync(REFERENCE_PATH, 'utf8');
const entities = parseStepEntities(text);
const edgeCurveUsers = buildEdgeCurveUsers(entities);

const targets = [
    { label: 'closed broad component', faceId: 7818, boundId: 7799 },
    { label: 'open broad component', faceId: 6693, boundId: 6692 },
];

console.log('investigate205 — FTC_07 rounded-edge adjacency');
console.log('Clean-room basis: inspect what surfaces sit across the rounded edges of the loops matched to broad-133.');

for (const target of targets) {
    const edges = buildBoundEdges(entities, target.faceId, target.boundId);
    console.log(`\n${target.label}: face=#${target.faceId} bound=#${target.boundId}`);
    for (const edge of edges.filter((entry) => entry.curveType !== 'LINE')) {
        const users = edgeCurveUsers.get(edge.edgeCurveId) ?? [];
        const others = users.filter((user) => user.faceId !== target.faceId);
        console.log(`  orientedEdge=#${edge.orientedEdgeId} edgeCurve=#${edge.edgeCurveId} curveType=${edge.curveType}`);
        for (const other of others) {
            console.log(`    adjacentFace=#${other.faceId} adjacentSurface=#${other.surfaceId} adjacentSurfaceType=${other.surfaceType} via orientedEdge=#${other.orientedEdgeId}`);
        }
    }
}