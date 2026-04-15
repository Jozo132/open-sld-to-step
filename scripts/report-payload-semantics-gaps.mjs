#!/usr/bin/env bun
/**
 * report-payload-semantics-gaps.mjs
 *
 * Summarizes how much of the Parasolid payload is currently mapped by our
 * clean-room semantics and where the largest unexplored gaps still sit.
 *
 * Scope of the report:
 * - raw type-0x0F FACE payload bytes
 * - type-0x11 shell/body payload segments
 * - marker-bearing type-0x1E/0x1F geometry payload families
 *
 * Categories:
 * - mapped: currently exposed with a stable parser meaning
 * - opaque: structurally extracted, but exact semantics still unresolved
 * - gap: not surfaced by the current parser semantics
 */
import {
    ENTITY_BSPLINE,
    ENTITY_FACE,
    ENTITY_SHELL,
    ENTITY_SURFACE,
    ParasolidParser,
    addCount,
    countStatuses,
    formatSpan,
    formatWord,
    formatWordList,
    getAllEntities,
    getStatusRuns,
    listSamplePaths,
    loadSample,
    makeSlots,
    markRange,
    mergeStatusTotals,
    percent,
    splitShellPayloadSegments,
    summarizeCountMap,
} from './_payload-gap-lib.mjs';

function analyzeFacePayloads(parser) {
    const entities = getAllEntities(parser).filter((entity) => entity.type === ENTITY_FACE);
    const coedgeIds = new Set(parser.parseCoedgeRecords().map((record) => record.id));
    const edgeIds = new Set(parser.parseEdgeRecords().map((record) => record.id));

    const totals = { mapped: 0, opaque: 0, gap: 0 };
    const gapRanges = new Map();
    const gapExamples = new Map();
    const anchorCounts = {
        shellId: 0,
        coedgeA: 0,
        edgeA: 0,
        coedgeB: 0,
        edgeB: 0,
    };
    let totalBytes = 0;

    for (const entity of entities) {
        totalBytes += entity.data.length;

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
            anchorCounts.shellId++;
            markRange(slots, 12, 14, 'opaque');
            markRange(slots, 14, 16, 'mapped');
            markRange(slots, 16, 18, 'opaque');
        }

        const anchorSpecs = [
            { key: 'coedgeA', start: 24, end: 26, ids: coedgeIds },
            { key: 'edgeA', start: 28, end: 30, ids: edgeIds },
            { key: 'coedgeB', start: 70, end: 72, ids: coedgeIds },
            { key: 'edgeB', start: 74, end: 76, ids: edgeIds },
        ];

        for (const spec of anchorSpecs) {
            if (entity.data.length < spec.end) continue;
            const value = entity.data.readUInt16BE(spec.start);
            if (!spec.ids.has(value)) continue;
            anchorCounts[spec.key]++;
            markRange(slots, spec.start, spec.end, 'mapped');
        }

        mergeStatusTotals(totals, countStatuses(slots));
        for (const run of getStatusRuns(slots, 'gap')) {
            const key = `${run.start}:${run.end}`;
            addCount(gapRanges, key);
            if (!gapExamples.has(key)) {
                gapExamples.set(key, {
                    faceId: entity.id,
                    length: entity.data.length,
                    preview: entity.data.subarray(run.start, Math.min(run.end, run.start + 24)),
                });
            }
        }
    }

    return {
        count: entities.length,
        totalBytes,
        totals,
        anchorCounts,
        topGapRanges: summarizeCountMap(gapRanges, 6).map(([key, count]) => {
            const [start, end] = key.split(':').map(Number);
            return { start, end, count, example: gapExamples.get(key) };
        }),
    };
}

function analyzeShellPayloads(parser) {
    const shellEntities = getAllEntities(parser).filter((entity) => entity.type === ENTITY_SHELL && entity.data.length >= 4);
    const linkKeys = new Set(
        parser.parseShellInlineContainerLinks().map((record) => `${record.shellId}:${record.segmentIndex}`),
    );
    const faceKeys = new Set(
        parser.parseShellInlineFaceRecords().map((record) => `${record.shellId}:${record.segmentIndex}`),
    );
    const anchorKeys = new Set(
        parser.parseShellInlineFaceAnchorRecords().map((record) => `${record.shellId}:${record.segmentIndex}`),
    );

    const totals = { mapped: 0, opaque: 0, gap: 0 };
    const familyCounts = new Map();
    const unresolvedFamilies = new Map();
    const unresolvedExamples = new Map();
    let segmentCount = 0;
    let totalWords = 0;

    for (const entity of shellEntities) {
        for (const segment of splitShellPayloadSegments(entity.data)) {
            const key = `${entity.id}:${segment.segmentIndex}`;
            const words = segment.words;
            const slots = new Array(words.length).fill('gap');
            let family = 'other';

            if (words.length === 2 && words[0] === ENTITY_SHELL && linkKeys.has(key)) {
                family = 'container-link';
                slots[0] = 'opaque';
                slots[1] = 'mapped';
            } else if (anchorKeys.has(key)) {
                family = 'inline-face-anchor';
                slots[0] = 'mapped';
                slots[1] = 'opaque';
                slots[2] = 'opaque';
                slots[3] = 'mapped';
                slots[4] = 'opaque';
                slots[5] = 'mapped';
            } else if (faceKeys.has(key) || (words[0] >> 8) === ENTITY_FACE) {
                family = 'inline-face-like';
                slots[0] = 'mapped';
            } else if (words[0] === 0x2b00) {
                family = 'inline-geom-2b';
                slots[0] = 'opaque';
            } else if (words[0] === 0x2d00) {
                family = 'inline-geom-2d';
                slots[0] = 'opaque';
            }

            segmentCount++;
            totalWords += words.length;
            addCount(familyCounts, family);
            mergeStatusTotals(totals, countStatuses(slots));

            if (family === 'container-link' || family === 'inline-face-anchor') continue;

            const leadWord = words.length > 0 ? formatWord(words[0]) : 'empty';
            const unresolvedKey = `${family} ${leadWord} len=${words.length}`;
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
        segmentCount,
        totalWords,
        totals,
        familyCounts: summarizeCountMap(familyCounts, 8),
        unresolvedFamilies: summarizeCountMap(unresolvedFamilies, 8).map(([key, count]) => ({
            key,
            count,
            example: unresolvedExamples.get(key),
        })),
    };
}

function analyzeGeometryPayloads(parser) {
    const entities = getAllEntities(parser).filter((entity) => {
        return entity.type === ENTITY_SURFACE || entity.type === ENTITY_BSPLINE;
    });

    const families = new Map();
    const examples = new Map();
    let markerBearingCount = 0;

    for (const entity of entities) {
        const result = ParasolidParser.readGeomFloats(entity.data);
        if (!result) continue;
        markerBearingCount++;

        let family = `${result.floats.length}-float unresolved`;
        if (result.floats.length === 11) family = '11-float cylinder-or-cone';
        else if (result.floats.length === 7) family = '7-float line-or-plane ambiguous';

        addCount(families, family);
        if (!examples.has(family)) {
            examples.set(family, {
                entityId: entity.id,
                marker: formatWord(result.marker),
                values: result.floats.slice(0, 5).map((value) => Number(value.toFixed(6))),
            });
        }
    }

    return {
        markerBearingCount,
        families: summarizeCountMap(families, 8).map(([family, count]) => ({
            family,
            count,
            example: examples.get(family),
        })),
    };
}

function printCoverage(label, totals, totalUnits, unitLabel) {
    console.log(
        `${label}: mapped ${percent(totals.mapped, totalUnits)} | opaque ${percent(totals.opaque, totalUnits)} | gap ${percent(totals.gap, totalUnits)} (${totalUnits} ${unitLabel})`,
    );
}

function printSampleSummary(fileName, faceSummary, shellSummary, geometrySummary) {
    console.log(`\n== ${fileName} ==`);

    console.log(`Raw face payloads: ${faceSummary.count} records`);
    printCoverage('  byte coverage', faceSummary.totals, faceSummary.totalBytes, 'bytes');
    console.log(
        `  mapped anchors: shell=${faceSummary.anchorCounts.shellId}, coedgeA=${faceSummary.anchorCounts.coedgeA}, edgeA=${faceSummary.anchorCounts.edgeA}, coedgeB=${faceSummary.anchorCounts.coedgeB}, edgeB=${faceSummary.anchorCounts.edgeB}`,
    );
    if (faceSummary.topGapRanges.length === 0) {
        console.log('  top raw-face gaps: none');
    } else {
        console.log('  top raw-face gaps:');
        for (const gap of faceSummary.topGapRanges) {
            console.log(
                `    - ${formatSpan(gap.start, gap.end, 'byte')}: ${gap.count} faces, example face ${gap.example.faceId}/${gap.example.length} bytes`,
            );
        }
    }

    console.log(`Shell payload segments: ${shellSummary.segmentCount} segments across ${shellSummary.shellEntityCount} shell entities`);
    printCoverage('  word coverage', shellSummary.totals, shellSummary.totalWords, 'words');
    console.log('  segment families:');
    for (const [family, count] of shellSummary.familyCounts) {
        console.log(`    - ${family}: ${count}`);
    }
    if (shellSummary.unresolvedFamilies.length === 0) {
        console.log('  unresolved segment families: none');
    } else {
        console.log('  unresolved segment families:');
        for (const family of shellSummary.unresolvedFamilies) {
            console.log(
                `    - ${family.key}: ${family.count} segments, example shell ${family.example.shellId} seg ${family.example.segmentIndex} -> ${formatWordList(family.example.words)}`,
            );
        }
    }

    console.log(`Geometry payload families: ${geometrySummary.markerBearingCount} marker-bearing raw geometry entities`);
    if (geometrySummary.families.length === 0) {
        console.log('  no geometry markers decoded');
    } else {
        for (const family of geometrySummary.families) {
            console.log(
                `    - ${family.family}: ${family.count}, example entity ${family.example.entityId} marker ${family.example.marker} -> ${family.example.values.join(', ')}`,
            );
        }
    }
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters);
if (samplePaths.length === 0) {
    throw new Error(`No NIST SLDPRT samples matched filters: ${filters.join(', ') || '(none)'}`);
}

const globalFaceTotals = { mapped: 0, opaque: 0, gap: 0 };
const globalShellTotals = { mapped: 0, opaque: 0, gap: 0 };
const globalFaceGaps = new Map();
const globalShellFamilies = new Map();
const globalShellUnresolved = new Map();
const globalGeometryFamilies = new Map();
let globalFaceBytes = 0;
let globalShellWords = 0;
let globalFaceCount = 0;
let globalShellSegments = 0;
let globalGeometryCount = 0;

console.log('Parasolid payload semantic gap report');
console.log('Clean-room scope: public NIST samples plus parser-decoded structural overlaps only.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const faceSummary = analyzeFacePayloads(parser);
    const shellSummary = analyzeShellPayloads(parser);
    const geometrySummary = analyzeGeometryPayloads(parser);

    mergeStatusTotals(globalFaceTotals, faceSummary.totals);
    mergeStatusTotals(globalShellTotals, shellSummary.totals);
    globalFaceBytes += faceSummary.totalBytes;
    globalShellWords += shellSummary.totalWords;
    globalFaceCount += faceSummary.count;
    globalShellSegments += shellSummary.segmentCount;
    globalGeometryCount += geometrySummary.markerBearingCount;

    for (const gap of faceSummary.topGapRanges) {
        addCount(globalFaceGaps, `${gap.start}:${gap.end}`, gap.count);
    }
    for (const [family, count] of shellSummary.familyCounts) {
        addCount(globalShellFamilies, family, count);
    }
    for (const family of shellSummary.unresolvedFamilies) {
        addCount(globalShellUnresolved, family.key, family.count);
    }
    for (const family of geometrySummary.families) {
        addCount(globalGeometryFamilies, family.family, family.count);
    }

    printSampleSummary(fileName, faceSummary, shellSummary, geometrySummary);
}

console.log('\n== Aggregate ==');
console.log(`Samples scanned: ${samplePaths.length}`);
console.log(`Raw faces: ${globalFaceCount}`);
printCoverage('  aggregate face-byte coverage', globalFaceTotals, globalFaceBytes, 'bytes');
console.log(`Shell segments: ${globalShellSegments}`);
printCoverage('  aggregate shell-word coverage', globalShellTotals, globalShellWords, 'words');
console.log(`Geometry marker entities: ${globalGeometryCount}`);

console.log('Top aggregate raw-face gap windows:');
for (const [key, count] of summarizeCountMap(globalFaceGaps, 6)) {
    const [start, end] = key.split(':').map(Number);
    console.log(`  - ${formatSpan(start, end, 'byte')}: ${count}`);
}

console.log('Top aggregate shell segment families:');
for (const [family, count] of summarizeCountMap(globalShellFamilies, 8)) {
    console.log(`  - ${family}: ${count}`);
}

console.log('Top aggregate unresolved shell families:');
for (const [family, count] of summarizeCountMap(globalShellUnresolved, 8)) {
    console.log(`  - ${family}: ${count}`);
}

console.log('Top aggregate geometry families:');
for (const [family, count] of summarizeCountMap(globalGeometryFamilies, 8)) {
    console.log(`  - ${family}: ${count}`);
}

console.log('Clean-room next targets:');
const topFaceGap = summarizeCountMap(globalFaceGaps, 1)[0];
if (topFaceGap) {
    const [start, end] = String(topFaceGap[0]).split(':').map(Number);
    console.log(`  - Raw-face payload window ${formatSpan(start, end, 'byte')} is the largest repeated unmapped face span.`);
}
const topShellGap = summarizeCountMap(globalShellUnresolved, 1)[0];
if (topShellGap) {
    console.log(`  - Shell payload family ${topShellGap[0]} is the largest repeated unresolved type-0x11 segment family.`);
}
const topGeometryGap = summarizeCountMap(globalGeometryFamilies, 1)[0];
if (topGeometryGap) {
    console.log(`  - Geometry family ${topGeometryGap[0]} is the dominant remaining geometry-payload classification bucket.`);
}
