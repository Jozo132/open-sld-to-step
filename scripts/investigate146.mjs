#!/usr/bin/env bun
/**
 * investigate146.mjs — Audit repeated unmapped raw-face payload windows.
 *
 * This script defends the clean-room gap claim by showing repeated byte spans
 * that remain unmapped inside raw type-0x0F FACE payloads, together with
 * representative hex previews from public NIST files only.
 */
import {
    ENTITY_FACE,
    ENTITY_SHELL,
    addCount,
    formatBytes,
    formatSpan,
    getAllEntities,
    getStatusRuns,
    listSamplePaths,
    loadSample,
    makeSlots,
    markRange,
    summarizeCountMap,
} from './_payload-gap-lib.mjs';

function analyzeSample(parser) {
    const faceEntities = getAllEntities(parser).filter((entity) => entity.type === ENTITY_FACE);
    const coedgeIds = new Set(parser.parseCoedgeRecords().map((record) => record.id));
    const edgeIds = new Set(parser.parseEdgeRecords().map((record) => record.id));

    const gapCounts = new Map();
    const gapExamples = new Map();
    let shellMarkerCount = 0;

    for (const entity of faceEntities) {
        const slots = makeSlots(entity.data.length);
        markRange(slots, 0, 2, 'opaque');
        markRange(slots, 2, 4, 'opaque');
        markRange(slots, 4, 6, 'opaque');
        markRange(slots, 6, 12, 'opaque');

        if (
            entity.data.length >= 18
            && entity.data.readUInt16BE(12) === ENTITY_SHELL
            && entity.data.readUInt16BE(16) === 1
        ) {
            shellMarkerCount++;
            markRange(slots, 12, 14, 'opaque');
            markRange(slots, 14, 16, 'mapped');
            markRange(slots, 16, 18, 'opaque');
        }

        const anchors = [
            { start: 24, end: 26, ids: coedgeIds },
            { start: 28, end: 30, ids: edgeIds },
            { start: 70, end: 72, ids: coedgeIds },
            { start: 74, end: 76, ids: edgeIds },
        ];
        for (const anchor of anchors) {
            if (entity.data.length < anchor.end) continue;
            if (!anchor.ids.has(entity.data.readUInt16BE(anchor.start))) continue;
            markRange(slots, anchor.start, anchor.end, 'mapped');
        }

        for (const run of getStatusRuns(slots, 'gap')) {
            const key = `${run.start}:${run.end}`;
            addCount(gapCounts, key);
            if (!gapExamples.has(key)) {
                gapExamples.set(key, {
                    faceId: entity.id,
                    payloadLength: entity.data.length,
                    preview: formatBytes(entity.data.subarray(run.start, run.end)),
                });
            }
        }
    }

    return {
        faceCount: faceEntities.length,
        shellMarkerCount,
        topGaps: summarizeCountMap(gapCounts, 8).map(([key, count]) => {
            const [start, end] = key.split(':').map(Number);
            return { start, end, count, example: gapExamples.get(key) };
        }),
    };
}

const samplePaths = listSamplePaths(process.argv.slice(2));

console.log('investigate146 — repeated unmapped raw-face payload windows');
console.log('Clean-room basis: observed byte positions in public NIST FACE payloads only.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const summary = analyzeSample(parser);
    if (summary.faceCount === 0) continue;

    console.log(`\n== ${fileName} ==`);
    console.log(`raw faces: ${summary.faceCount}, shell markers: ${summary.shellMarkerCount}`);
    if (summary.topGaps.length === 0) {
        console.log('  no unmapped gaps found');
        continue;
    }

    for (const gap of summary.topGaps) {
        console.log(
            `  - ${formatSpan(gap.start, gap.end, 'byte')}: ${gap.count} faces, example face ${gap.example.faceId}/${gap.example.payloadLength} -> ${gap.example.preview}`,
        );
    }
}
