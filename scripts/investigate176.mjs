#!/usr/bin/env bun
/**
 * investigate176.mjs — Correlate reference B-spline surfaces with compact type-31 span families.
 *
 * Goal:
 * 1. Parse public NIST STEP definitions robustly, including complex-entity syntax,
 *    and summarize the reference B-spline surface patch signatures.
 * 2. Scan compact and packed type-31 geometry-like records in the matching
 *    Parasolid payload and measure their true byte spans to the next direct
 *    geometry-like record.
 * 3. Separate the dominant short type-31 families from the sparse large-span
 *    families that are stronger B-spline candidates.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    ROOT,
    listSamplePaths,
    loadSample,
} from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const LARGE_PAYLOAD_BYTES = 500;

function referencePathForSample(fileName) {
    const lower = fileName.toLowerCase();
    const definitionDir = lower.includes('_ctc_') ? 'CTC Definitions' : 'FTC Definitions';
    return path.join(
        REFERENCE_ROOT,
        definitionDir,
        lower.replace('_sw1802.sldprt', '.stp'),
    );
}

function extractJoinedData(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return '';
    return normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
}

function iterateStepEntityBodies(text) {
    const joined = extractJoinedData(text);
    const lineRe = /^#(\d+)\s*=\s*(.+);$/gm;
    const bodies = [];
    let match;
    while ((match = lineRe.exec(joined)) !== null) {
        bodies.push({ id: Number(match[1]), body: match[2].trim() });
    }
    return bodies;
}

function findMatchingParen(text, openIndex) {
    let depth = 0;
    let inString = false;

    for (let index = openIndex; index < text.length; index++) {
        const ch = text[index];
        if (ch === '\'') {
            if (inString && text[index + 1] === '\'') {
                index++;
                continue;
            }
            inString = !inString;
            continue;
        }

        if (inString) continue;
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return index;
        }
    }

    return -1;
}

function parseComplexEntitySegments(body) {
    const trimmed = body.trim();
    if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null;

    const inner = trimmed.slice(1, -1);
    const segments = new Map();
    let index = 0;

    while (index < inner.length) {
        while (index < inner.length && /\s/.test(inner[index])) index++;
        const match = /^[A-Z_][A-Z0-9_]*/.exec(inner.slice(index));
        if (!match) break;

        const type = match[0];
        index += type.length;
        while (index < inner.length && /\s/.test(inner[index])) index++;
        if (inner[index] !== '(') break;

        const closeIndex = findMatchingParen(inner, index);
        if (closeIndex < 0) break;

        segments.set(type, inner.slice(index + 1, closeIndex));
        index = closeIndex + 1;
    }

    return segments;
}

function splitTopLevelArgs(text) {
    const parts = [];
    let current = '';
    let depth = 0;
    let inString = false;

    for (let index = 0; index < text.length; index++) {
        const ch = text[index];
        if (ch === '\'') {
            current += ch;
            if (inString && text[index + 1] === '\'') {
                current += text[index + 1];
                index++;
                continue;
            }
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === ',' && depth === 0) {
                parts.push(current.trim());
                current = '';
                continue;
            }
        }

        current += ch;
    }

    if (current.trim().length > 0) parts.push(current.trim());
    return parts;
}

function splitTopLevelGroups(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return [];

    const inner = trimmed.slice(1, -1);
    const groups = [];
    let current = '';
    let depth = 0;
    let inString = false;

    for (let index = 0; index < inner.length; index++) {
        const ch = inner[index];
        if (ch === '\'') {
            current += ch;
            if (inString && inner[index + 1] === '\'') {
                current += inner[index + 1];
                index++;
                continue;
            }
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === ',' && depth === 0) {
                if (current.trim().length > 0) groups.push(current.trim());
                current = '';
                continue;
            }
        }

        current += ch;
    }

    if (current.trim().length > 0) groups.push(current.trim());
    return groups;
}

function parseNumberList(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return [];
    return splitTopLevelArgs(trimmed.slice(1, -1))
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
}

function parseControlNetShape(text) {
    const rows = splitTopLevelGroups(text);
    const rowCount = rows.length;
    const colCounts = rows.map((row) => [...row.matchAll(/#(\d+)/g)].length);
    const colCount = colCounts.length > 0 ? Math.max(...colCounts) : 0;
    return { rowCount, colCount, colCounts };
}

function extractReferenceBsplineSurfaces(fileName) {
    const referencePath = referencePathForSample(fileName);
    const text = fs.readFileSync(referencePath, 'utf8');
    const surfaces = [];

    for (const entity of iterateStepEntityBodies(text)) {
        if (!entity.body.includes('B_SPLINE_SURFACE_WITH_KNOTS')) continue;

        let uDegree;
        let vDegree;
        let controlNet;
        let uMults;
        let vMults;
        let uKnots;
        let vKnots;

        const simple = entity.body.match(/^B_SPLINE_SURFACE_WITH_KNOTS\s*\((.+)\)$/s);
        if (simple) {
            const args = splitTopLevelArgs(simple[1]);
            if (args.length < 13) continue;

            uDegree = Number(args[1]);
            vDegree = Number(args[2]);
            controlNet = parseControlNetShape(args[3]);
            uMults = parseNumberList(args[8]);
            vMults = parseNumberList(args[9]);
            uKnots = parseNumberList(args[10]);
            vKnots = parseNumberList(args[11]);
        } else {
            const segments = parseComplexEntitySegments(entity.body);
            if (!segments || !segments.has('B_SPLINE_SURFACE_WITH_KNOTS') || !segments.has('B_SPLINE_SURFACE')) continue;

            const surfaceArgs = splitTopLevelArgs(segments.get('B_SPLINE_SURFACE'));
            const knotArgs = splitTopLevelArgs(segments.get('B_SPLINE_SURFACE_WITH_KNOTS'));
            if (surfaceArgs.length < 3 || knotArgs.length < 4) continue;

            uDegree = Number(surfaceArgs[0]);
            vDegree = Number(surfaceArgs[1]);
            controlNet = parseControlNetShape(surfaceArgs[2]);
            uMults = parseNumberList(knotArgs[0]);
            vMults = parseNumberList(knotArgs[1]);
            uKnots = parseNumberList(knotArgs[2]);
            vKnots = parseNumberList(knotArgs[3]);
        }

        if (!Number.isFinite(uDegree) || !Number.isFinite(vDegree)) continue;
        if (!controlNet || controlNet.rowCount === 0 || controlNet.colCount === 0) continue;

        surfaces.push({
            id: entity.id,
            uDegree,
            vDegree,
            rowCount: controlNet.rowCount,
            colCount: controlNet.colCount,
            uMultCount: uMults.length,
            vMultCount: vMults.length,
            uKnotCount: uKnots.length,
            vKnotCount: vKnots.length,
            uMultSum: uMults.reduce((sum, value) => sum + value, 0),
            vMultSum: vMults.reduce((sum, value) => sum + value, 0),
        });
    }

    return surfaces;
}

function summarizeReferenceFamilies(surfaces) {
    const families = new Map();
    for (const surface of surfaces) {
        const key = [
            `deg=${surface.uDegree}x${surface.vDegree}`,
            `net=${surface.rowCount}x${surface.colCount}`,
            `uM=${surface.uMultCount}/${surface.uMultSum}`,
            `vM=${surface.vMultCount}/${surface.vMultSum}`,
            `uK=${surface.uKnotCount}`,
            `vK=${surface.vKnotCount}`,
        ].join(' ');
        const entry = families.get(key) ?? { count: 0, sample: surface };
        entry.count++;
        families.set(key, entry);
    }

    return [...families.entries()]
        .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
        .map(([key, value]) => ({ key, count: value.count, sampleId: value.sample.id }));
}

function payloadStartOffset(record) {
    return 'trailer' in record ? record.offset + 20 : record.offset + 19;
}

function readLeadingDoubles(buf, start, end, limit = 10) {
    const doubles = [];
    for (let offset = start; offset + 8 <= end && doubles.length < limit; offset += 8) {
        doubles.push(buf.readDoubleBE(offset));
    }
    return doubles;
}

function summarizeType31Families(parser, payload) {
    const compact = parser.parseCompactGeometryLikeRecords();
    const packed = parser.parsePackedGeometryLikeRecords();
    const direct = [...compact, ...packed].sort((left, right) => left.offset - right.offset);
    const type31 = direct.filter((record) => record.type === 0x1f);
    const families = new Map();

    for (let index = 0; index < direct.length; index++) {
        const record = direct[index];
        if (record.type !== 0x1f) continue;

        const start = payloadStartOffset(record);
        const nextOffset = direct[index + 1]?.offset ?? payload.length;
        const payloadBytes = Math.max(0, nextOffset - start);
        const doubles = Math.floor(payloadBytes / 8);
        const remainder = payloadBytes % 8;
        const key = `${doubles}d+${remainder}`;
        const entry = families.get(key) ?? {
            count: 0,
            payloadBytes,
            large: payloadBytes >= LARGE_PAYLOAD_BYTES,
            sample: {
                id: record.id,
                markerByte: record.markerByte,
                flags: record.flags,
                refIds: record.refIds,
                leadingDoubles: readLeadingDoubles(payload, start, nextOffset),
            },
        };
        entry.count++;
        families.set(key, entry);
    }

    return {
        compactCount: compact.length,
        packedCount: packed.length,
        directCount: type31.length,
        familyRows: [...families.entries()]
            .map(([key, value]) => ({ key, ...value }))
            .sort((left, right) => {
                if (right.count !== left.count) return right.count - left.count;
                if (right.payloadBytes !== left.payloadBytes) return right.payloadBytes - left.payloadBytes;
                return left.key.localeCompare(right.key);
            }),
    };
}

function formatLeadingDoubles(values) {
    return values.map((value) => Number.isFinite(value) ? Number(value.toPrecision(6)) : value).join(', ');
}

const filters = process.argv.slice(2);
const requested = filters.length > 0 ? filters : ['ctc_02', 'ctc_05', 'ftc_07', 'ftc_10'];
const samplePaths = listSamplePaths(requested);

console.log('investigate176 — reference B-spline vs compact type-31 span families');
console.log('Clean-room basis: correlate public STEP B-spline surface signatures with direct type-31 record spans in the extracted Parasolid payload.');
console.log(`Large-family threshold: ${LARGE_PAYLOAD_BYTES} bytes.`);

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const referenceBsplines = extractReferenceBsplineSurfaces(fileName);
    const referenceFamilies = summarizeReferenceFamilies(referenceBsplines);
    const type31 = summarizeType31Families(parser, extraction.data);
    const explicitFaces = parser.parseFaceRecords().length;
    const inlineFaces = parser.parseShellInlineFaceRecords().length;

    console.log(`\n== ${fileName} ==`);
    console.log(`reference B-spline surfaces: ${referenceBsplines.length}`);
    if (referenceFamilies.length === 0) {
        console.log('reference families: none');
    } else {
        console.log('reference families:');
        for (const family of referenceFamilies) {
            console.log(`  - count=${family.count} sample=#${family.sampleId} ${family.key}`);
        }
    }

    console.log(`explicit FACE records: ${explicitFaces}`);
    console.log(`shell-inline FACE records: ${inlineFaces}`);
    console.log(`compact geometry-like records: ${type31.compactCount}`);
    console.log(`packed geometry-like records: ${type31.packedCount}`);
    console.log(`direct type-31 records: ${type31.directCount}`);

    const shortFamilies = type31.familyRows.filter((family) => !family.large).slice(0, 8);
    const largeFamilies = type31.familyRows.filter((family) => family.large);

    console.log('short type-31 families:');
    if (shortFamilies.length === 0) {
        console.log('  - none');
    } else {
        for (const family of shortFamilies) {
            console.log(
                `  - ${family.key} count=${family.count} bytes=${family.payloadBytes} ` +
                `exampleId=${family.sample.id} marker=0x${family.sample.markerByte.toString(16)} ` +
                `refs=${family.sample.refIds.join(',')}`,
            );
        }
    }

    console.log('large type-31 families:');
    if (largeFamilies.length === 0) {
        console.log('  - none');
    } else {
        for (const family of largeFamilies) {
            console.log(
                `  - ${family.key} count=${family.count} bytes=${family.payloadBytes} ` +
                `exampleId=${family.sample.id} marker=0x${family.sample.markerByte.toString(16)} ` +
                `refs=${family.sample.refIds.join(',')}`,
            );
            console.log(`    leading doubles: ${formatLeadingDoubles(family.sample.leadingDoubles)}`);
        }
    }
}