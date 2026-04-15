#!/usr/bin/env bun
/**
 * investigate147.mjs — Audit shell segment families and short inline face anchors.
 *
 * This script defends the clean-room shell semantics claim by showing:
 * - repeated type-0x11 segment families across public NIST files
 * - the stable short inline face family whose coedge and edge anchors land at
 *   fixed positions through overlap with already-decoded global ids
 * - the largest remaining unresolved segment families with representative words
 */
import {
    ENTITY_FACE,
    ENTITY_SHELL,
    addCount,
    formatWordList,
    listSamplePaths,
    loadSample,
    splitShellPayloadSegments,
    summarizeCountMap,
} from './_payload-gap-lib.mjs';

function analyzeSample(parser) {
    const shellEntities = parser.extractAllEntities().filter((entity) => entity.type === ENTITY_SHELL && entity.data.length >= 4);
    const anchorKeys = new Set(
        parser.parseShellInlineFaceAnchorRecords().map((record) => `${record.shellId}:${record.segmentIndex}`),
    );
    const faceKeys = new Set(
        parser.parseShellInlineFaceRecords().map((record) => `${record.shellId}:${record.segmentIndex}`),
    );
    const linkKeys = new Set(
        parser.parseShellInlineContainerLinks().map((record) => `${record.shellId}:${record.segmentIndex}`),
    );
    const coedgeIds = new Set(parser.parseCoedgeRecords().map((record) => record.id));
    const edgeIds = new Set(parser.parseEdgeRecords().map((record) => record.id));

    const familyCounts = new Map();
    const unresolvedFamilies = new Map();
    const unresolvedExamples = new Map();
    const coedgePositions = [0, 0, 0, 0, 0];
    const edgePositions = [0, 0, 0, 0, 0];
    let shortInlineFaceCount = 0;
    let stableAnchorCount = 0;

    for (const entity of shellEntities) {
        for (const segment of splitShellPayloadSegments(entity.data)) {
            const key = `${entity.id}:${segment.segmentIndex}`;
            const words = segment.words;
            let family = 'other';

            if (words.length === 2 && words[0] === ENTITY_SHELL && linkKeys.has(key)) {
                family = 'container-link';
            } else if (anchorKeys.has(key)) {
                family = 'inline-face-anchor';
            } else if (faceKeys.has(key) || (words[0] >> 8) === ENTITY_FACE) {
                family = 'inline-face-like';
            } else if (words[0] === 0x2b00) {
                family = 'inline-geom-2b';
            } else if (words[0] === 0x2d00) {
                family = 'inline-geom-2d';
            }

            addCount(familyCounts, family);

            if ((words[0] >> 8) === ENTITY_FACE && words.length === 6) {
                shortInlineFaceCount++;
                const refs = words.slice(1);
                refs.forEach((ref, index) => {
                    if (coedgeIds.has(ref)) coedgePositions[index]++;
                    if (edgeIds.has(ref)) edgePositions[index]++;
                });
                if (coedgeIds.has(refs[2]) && edgeIds.has(refs[4])) stableAnchorCount++;
            }

            if (family === 'container-link' || family === 'inline-face-anchor') continue;

            const unresolvedKey = `${family} len=${words.length}`;
            addCount(unresolvedFamilies, unresolvedKey);
            if (!unresolvedExamples.has(unresolvedKey)) {
                unresolvedExamples.set(unresolvedKey, {
                    shellId: entity.id,
                    segmentIndex: segment.segmentIndex,
                    words: words.slice(),
                });
            }
        }
    }

    return {
        shellEntityCount: shellEntities.length,
        familyCounts: summarizeCountMap(familyCounts, 8),
        shortInlineFaceCount,
        stableAnchorCount,
        coedgePositions,
        edgePositions,
        unresolvedFamilies: summarizeCountMap(unresolvedFamilies, 8).map(([key, count]) => ({
            key,
            count,
            example: unresolvedExamples.get(key),
        })),
    };
}

const samplePaths = listSamplePaths(process.argv.slice(2));

console.log('investigate147 — shell segment families and short inline face anchors');
console.log('Clean-room basis: repeated type-0x11 word patterns plus overlap with already-decoded coedge and edge ids.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const summary = analyzeSample(parser);

    if (summary.shellEntityCount === 0) continue;

    console.log(`\n== ${fileName} ==`);
    console.log(`shell entities: ${summary.shellEntityCount}`);
    console.log('segment families:');
    for (const [family, count] of summary.familyCounts) {
        console.log(`  - ${family}: ${count}`);
    }

    console.log(`short 6-word inline face records: ${summary.shortInlineFaceCount}`);
    console.log(`stable short anchor records (coedge at refs[2], edge at refs[4]): ${summary.stableAnchorCount}`);
    console.log(`coedge position hits across refs[0..4]: ${summary.coedgePositions.join(', ')}`);
    console.log(`edge position hits across refs[0..4]: ${summary.edgePositions.join(', ')}`);

    if (summary.unresolvedFamilies.length === 0) {
        console.log('largest unresolved families: none');
        continue;
    }

    console.log('largest unresolved families:');
    for (const family of summary.unresolvedFamilies) {
        console.log(
            `  - ${family.key}: ${family.count}, example shell ${family.example.shellId} seg ${family.example.segmentIndex} -> ${formatWordList(family.example.words)}`,
        );
    }
}
