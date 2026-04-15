#!/usr/bin/env bun
/**
 * investigate151.mjs — Test raw FACE inline-tag namespace overlap with shell-inline faces.
 *
 * Probes the most direct possible bridge between the new raw FACE 30-69 window
 * decoder and the existing type-0x11 shell-inline face decoder: whether the
 * FACE inline tag word (0x11xx or 0x0Fxx) shares a local id namespace with
 * parseShellInlineFaceRecords() under the same shell id.
 *
 * Clean-room scope:
 * - compares only parser-decoded structural records from public NIST files
 * - does not infer semantics when ids fail to align
 * - records negative overlap evidence so the parser does not grow speculative
 *   cross-namespace logic
 */
import {
    listSamplePaths,
    loadSample,
} from './_payload-gap-lib.mjs';

const DEFAULT_FILTERS = ['ctc_02', 'ftc_07', 'ftc_08'];

function analyzeSample(parser) {
    const faceWindows = parser.parseFaceInlineWindowRecords()
        .filter((record) => {
            const highByte = record.inlineTagWord >> 8;
            return highByte === 0x11 || highByte === 0x0f;
        });
    const shellRecords = parser.parseShellInlineFaceRecords();
    const byShellInline = new Map();
    const shellCounts = new Map();

    for (const record of shellRecords) {
        const key = `${record.shellId}:${record.inlineId}`;
        const bucket = byShellInline.get(key) ?? [];
        bucket.push(record);
        byShellInline.set(key, bucket);
        shellCounts.set(record.shellId, (shellCounts.get(record.shellId) ?? 0) + 1);
    }

    let exactMatches = 0;
    let shellOnlyMatches = 0;
    const examples = [];

    for (const record of faceWindows) {
        const inlineId = record.inlineTagWord & 0xff;
        const exact = byShellInline.get(`${record.shellId}:${inlineId}`) ?? [];
        const shellRecordCount = record.shellId === null ? 0 : (shellCounts.get(record.shellId) ?? 0);

        if (exact.length > 0) exactMatches++;
        else if (shellRecordCount > 0) shellOnlyMatches++;

        if (examples.length < 12) {
            examples.push({
                faceId: record.faceId,
                shellId: record.shellId,
                markerWord: record.markerWord,
                inlineTagWord: record.inlineTagWord,
                inlineId,
                exactMatchCount: exact.length,
                shellRecordCount,
                exactSegmentPreview: exact.slice(0, 3).map((candidate) => ({
                    segmentIndex: candidate.segmentIndex,
                    inlineId: candidate.inlineId,
                    wordLength: candidate.wordLength,
                    refs: candidate.refs.slice(0, 5),
                })),
            });
        }
    }

    return {
        faceWindowCount: faceWindows.length,
        shellRecordCount: shellRecords.length,
        exactMatches,
        shellOnlyMatches,
        unmatched: faceWindows.length - exactMatches - shellOnlyMatches,
        examples,
    };
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate151 — raw FACE inline-tag namespace overlap with shell-inline faces');
console.log('Clean-room basis: compare FACE 30-69 inline tag ids against decoded type-0x11 shell-inline face ids under the same shell id.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    console.log(`\n== ${fileName} ==`);
    console.log(JSON.stringify(analyzeSample(parser), null, 2));
}
