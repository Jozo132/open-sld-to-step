#!/usr/bin/env bun
/**
 * investigate150.mjs — Normalize the 30-69 raw FACE gap window into layout families.
 *
 * Probes the largest remaining FACE payload gap as a positional structure
 * instead of literal words. The goal is to determine whether the 30-69 byte
 * window behaves like a stable inline record layout with shell-local ids
 * plugged into fixed slots.
 *
 * Clean-room scope:
 * - analyzes public NIST FACE payloads only
 * - classifies each uint16 word by structural role, not proprietary meaning
 * - reports repeated normalized layouts and per-offset token frequencies
 */
import {
    ENTITY_BSPLINE,
    ENTITY_EDGE,
    ENTITY_FACE,
    ENTITY_SHELL,
    ENTITY_SURFACE,
    addCount,
    getAllEntities,
    listSamplePaths,
    loadSample,
    summarizeCountMap,
} from './_payload-gap-lib.mjs';

const DEFAULT_FILTERS = ['ctc_02', 'ftc_07', 'ftc_08'];
const WINDOW_START = 30;
const WINDOW_END = 70;

function extractShellId(entity) {
    return entity.data.length >= 18
        && entity.data.readUInt16BE(12) === ENTITY_SHELL
        && entity.data.readUInt16BE(16) === 1
        ? entity.data.readUInt16BE(14)
        : null;
}

function classifyWord(word, faceId, shellId, rawTypeById) {
    if (word === 1) return 'SEP';
    if (word === 0x2b00) return 'MARK_2B';
    if (word === 0x2d00) return 'MARK_2D';
    if (word === faceId) return 'SELF_FACE';
    if (shellId !== null && word === shellId) return 'SELF_SHELL';

    const rawType = rawTypeById.get(word);
    if (rawType === ENTITY_FACE) return 'RAW_FACE';
    if (rawType === ENTITY_EDGE) return 'RAW_EDGE';
    if (rawType === ENTITY_SHELL) return 'RAW_SHELL';
    if (rawType === ENTITY_SURFACE) return 'RAW_SURFACE';
    if (rawType === ENTITY_BSPLINE) return 'RAW_BSPLINE';

    const highByte = word >> 8;
    if (highByte === 0x11) return 'TAG_11';
    if (highByte === 0x0f) return 'TAG_0F';
    if (highByte === 0x1e) return 'TAG_1E';
    if (highByte === 0x1d) return 'TAG_1D';
    if (highByte === 0x1c) return 'TAG_1C';

    return 'LOCAL';
}

function analyzeSample(parser) {
    const rawEntities = getAllEntities(parser);
    const rawTypeById = new Map(rawEntities.map((entity) => [entity.id, entity.type]));
    const faceEntities = rawEntities.filter((entity) => entity.type === ENTITY_FACE && entity.data.length >= WINDOW_END);
    const offsetCounts = new Map();
    const layoutCounts = new Map();

    for (let offset = WINDOW_START; offset < WINDOW_END; offset += 2) {
        offsetCounts.set(offset, new Map());
    }

    for (const entity of faceEntities) {
        const shellId = extractShellId(entity);
        const tokens = [];

        for (let offset = WINDOW_START; offset < WINDOW_END; offset += 2) {
            const label = classifyWord(entity.data.readUInt16BE(offset), entity.id, shellId, rawTypeById);
            addCount(offsetCounts.get(offset), label);
            tokens.push(label);
        }

        const key = tokens.join(' ');
        const bucket = layoutCounts.get(key) ?? { count: 0, faceIds: [] };
        bucket.count++;
        if (bucket.faceIds.length < 8) bucket.faceIds.push(entity.id);
        layoutCounts.set(key, bucket);
    }

    return {
        faceCount: faceEntities.length,
        offsetSummaries: [...offsetCounts.entries()].map(([offset, counts]) => ({
            offset,
            counts: summarizeCountMap(counts, 5).map(([label, count]) => ({ label, count })),
        })),
        layoutSummaries: [...layoutCounts.entries()]
            .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
            .slice(0, 10)
            .map(([pattern, bucket]) => ({
                count: bucket.count,
                faceIds: bucket.faceIds,
                pattern,
            })),
    };
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate150 — normalized raw FACE 30-69 layout families');
console.log('Clean-room basis: classify the largest FACE payload gap by structural token roles instead of literal ids.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const summary = analyzeSample(parser);
    if (summary.faceCount === 0) continue;

    console.log(`\n== ${fileName} ==`);
    console.log(`faces with 30-69 window: ${summary.faceCount}`);
    console.log('offset profiles:');
    for (const offset of summary.offsetSummaries) {
        console.log(
            `  - ${offset.offset}: ${offset.counts.map((entry) => `${entry.label}=${entry.count}`).join(', ')}`,
        );
    }
    console.log('top normalized layouts:');
    for (const layout of summary.layoutSummaries) {
        console.log(`  - ${layout.count} face(s) [${layout.faceIds.join(', ')}]: ${layout.pattern}`);
    }
}
