/**
 * _payload-gap-lib.mjs
 *
 * Shared helpers for payload-gap reporting and supporting clean-room
 * investigation scripts.
 *
 * This module intentionally stays at the structural-observation layer:
 * - loads public NIST SolidWorks sample files
 * - exposes parser entrypoints needed by the report/investigate scripts
 * - provides neutral coverage, formatting, and payload-segmentation helpers
 *
 * It does not assign proprietary semantics beyond what the parser already
 * decodes from observable byte patterns in the public test corpus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = process.cwd();
export const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

export const ENTITY_EDGE = 0x10;
export const ENTITY_SHELL = 0x11;
export const ENTITY_FACE = 0x0f;
export const ENTITY_SURFACE = 0x1e;
export const ENTITY_BSPLINE = 0x1f;

export const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'parser', 'ParasolidParser.ts')).href,
);
export const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'parser', 'SldprtContainerParser.ts')).href,
);

const STATUS_PRIORITY = {
    gap: 0,
    opaque: 1,
    mapped: 2,
};

export function listSamplePaths(filters = []) {
    if (!fs.existsSync(SAMPLE_DIR)) {
        throw new Error(`Sample directory not found: ${SAMPLE_DIR}`);
    }

    const sampleNames = fs.readdirSync(SAMPLE_DIR)
        .filter((name) => name.toLowerCase().endsWith('.sldprt'))
        .sort((left, right) => left.localeCompare(right));

    if (filters.length === 0) {
        return sampleNames.map((name) => path.join(SAMPLE_DIR, name));
    }

    const loweredFilters = filters.map((value) => value.toLowerCase());
    return sampleNames
        .filter((name) => loweredFilters.some((value) => name.toLowerCase().includes(value)))
        .map((name) => path.join(SAMPLE_DIR, name));
}

export function loadSample(samplePath) {
    const buffer = fs.readFileSync(samplePath);
    const extraction = SldprtContainerParser.extractParasolid(buffer);
    if (!extraction) {
        throw new Error(`Failed to extract Parasolid payload from ${path.basename(samplePath)}`);
    }

    return {
        samplePath,
        fileName: path.basename(samplePath),
        extraction,
        parser: new ParasolidParser(extraction.data),
    };
}

export function getAllEntities(parser) {
    return parser.extractAllEntities();
}

export function splitShellPayloadSegments(data) {
    const segments = [];
    let segmentIndex = 0;
    let currentWords = [];

    for (let offset = 0; offset + 2 <= data.length; offset += 2) {
        const word = data.readUInt16BE(offset);
        if (word === 1) {
            if (currentWords.length > 0) {
                segments.push({ segmentIndex, words: currentWords });
                segmentIndex++;
            }
            currentWords = [];
            continue;
        }

        currentWords.push(word);
    }

    if (currentWords.length > 0) {
        segments.push({ segmentIndex, words: currentWords });
    }

    return segments;
}

export function makeSlots(length) {
    return new Array(length).fill('gap');
}

export function markRange(slots, start, endExclusive, status) {
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(slots.length, endExclusive);
    for (let index = safeStart; index < safeEnd; index++) {
        if (STATUS_PRIORITY[status] > STATUS_PRIORITY[slots[index]]) {
            slots[index] = status;
        }
    }
}

export function countStatuses(slots) {
    const counts = { mapped: 0, opaque: 0, gap: 0 };
    for (const slot of slots) {
        counts[slot]++;
    }
    return counts;
}

export function getStatusRuns(slots, wantedStatus) {
    const runs = [];
    let start = -1;

    for (let index = 0; index < slots.length; index++) {
        if (slots[index] === wantedStatus) {
            if (start < 0) start = index;
            continue;
        }
        if (start >= 0) {
            runs.push({ start, end: index });
            start = -1;
        }
    }

    if (start >= 0) {
        runs.push({ start, end: slots.length });
    }

    return runs;
}

export function addCount(map, key, delta = 1) {
    map.set(key, (map.get(key) ?? 0) + delta);
}

export function mergeStatusTotals(target, source) {
    target.mapped += source.mapped;
    target.opaque += source.opaque;
    target.gap += source.gap;
}

export function summarizeCountMap(map, limit = 8) {
    return [...map.entries()]
        .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
        .slice(0, limit);
}

export function formatWord(word) {
    return `0x${word.toString(16).padStart(4, '0')}`;
}

export function formatWordList(words, limit = 8) {
    const preview = words.slice(0, limit).map((word) => formatWord(word)).join(' ');
    return words.length > limit ? `${preview} ...` : preview;
}

export function formatBytes(buffer, limit = 24) {
    const preview = [...buffer.subarray(0, limit)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ');
    return buffer.length > limit ? `${preview} ...` : preview;
}

export function formatSpan(start, endExclusive, unitLabel) {
    const size = Math.max(0, endExclusive - start);
    const label = size === 1 ? unitLabel : `${unitLabel}s`;
    return `${start}-${Math.max(start, endExclusive - 1)} (${size} ${label})`;
}

export function percent(part, whole) {
    if (whole === 0) return '0.0%';
    return `${((part / whole) * 100).toFixed(1)}%`;
}
