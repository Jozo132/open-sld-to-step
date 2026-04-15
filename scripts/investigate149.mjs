#!/usr/bin/env bun
/**
 * investigate149.mjs — Classify dominant raw-face gap-window words.
 *
 * Probes the repeated unmapped FACE payload windows discovered in
 * investigate146.mjs to determine whether their words already resolve to known
 * global raw entity ids or remain face-local / shell-local namespaces.
 *
 * Focus windows:
 * - bytes 18-23  -> three uint16 words
 * - bytes 26-27  -> one uint16 word
 * - bytes 72-73  -> one uint16 word
 *
 * Clean-room scope:
 * - compares payload words only against raw entity ids from extractAllEntities()
 * - reports exact self-face / shell-id relations separately
 * - avoids synthetic parser ids such as renumbered extracted surfaces
 */
import {
    ENTITY_FACE,
    ENTITY_SHELL,
    addCount,
    getAllEntities,
    listSamplePaths,
    loadSample,
    summarizeCountMap,
} from './_payload-gap-lib.mjs';

const DEFAULT_FILTERS = ['ctc_02', 'ftc_07', 'ftc_08'];
const OFFSETS = [18, 20, 22, 26, 72];

function classifyValue(faceId, shellId, value, rawTypeById) {
    if (value === null) return 'missing';
    if (value === faceId) return 'self-face-id';
    if (shellId !== null && value === shellId) return 'embedded-shell-id';

    const rawType = rawTypeById.get(value);
    if (rawType === ENTITY_FACE) return 'other-face-id';
    if (rawType === ENTITY_SHELL) return 'raw-shell-id';
    if (rawType !== undefined) return `raw-type-${rawType}`;

    return 'unresolved-local';
}

function analyzeSample(parser) {
    const rawEntities = getAllEntities(parser);
    const rawTypeById = new Map(rawEntities.map((entity) => [entity.id, entity.type]));
    const faceEntities = rawEntities.filter((entity) => entity.type === ENTITY_FACE);
    const summaries = new Map(OFFSETS.map((offset) => [offset, new Map()]));
    const examples = new Map();

    for (const entity of faceEntities) {
        const shellId = entity.data.length >= 18
            && entity.data.readUInt16BE(12) === ENTITY_SHELL
            && entity.data.readUInt16BE(16) === 1
            ? entity.data.readUInt16BE(14)
            : null;

        for (const offset of OFFSETS) {
            const value = entity.data.length >= offset + 2 ? entity.data.readUInt16BE(offset) : null;
            const label = classifyValue(entity.id, shellId, value, rawTypeById);
            addCount(summaries.get(offset), label);

            const exampleKey = `${offset}:${label}`;
            if (!examples.has(exampleKey)) {
                examples.set(exampleKey, {
                    faceId: entity.id,
                    shellId,
                    value,
                    length: entity.data.length,
                });
            }
        }
    }

    return OFFSETS.map((offset) => ({
        offset,
        counts: summarizeCountMap(summaries.get(offset), 8).map(([label, count]) => ({
            label,
            count,
            example: examples.get(`${offset}:${label}`),
        })),
    }));
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate149 — dominant raw-face gap-window word classification');
console.log('Clean-room basis: compare repeated FACE gap words against raw entity ids only; synthetic parser ids are excluded.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const summaries = analyzeSample(parser);

    console.log(`\n== ${fileName} ==`);
    for (const summary of summaries) {
        console.log(`offset ${summary.offset}:`);
        for (const entry of summary.counts) {
            console.log(
                `  - ${entry.label}: ${entry.count}, example face ${entry.example.faceId} shell ${entry.example.shellId ?? 'null'} value ${entry.example.value ?? 'null'} length ${entry.example.length}`,
            );
        }
    }
}
