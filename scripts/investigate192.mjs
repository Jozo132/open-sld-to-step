#!/usr/bin/env bun
/**
 * investigate192.mjs — Compare FTC_07 wrapper endcaps against an interior wrapper.
 *
 * Goal:
 * 1. Inspect direct type-30 wrappers 16, 51, and 90 side by side.
 * 2. Report marker positions, shifted float decodes, and aligned word layouts.
 * 3. Determine whether the endcaps carry additional transition payload beyond
 *    the stable interior wrapper family.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const TARGET_IDS = [16, 51, 90];

function payloadStartOffset(record) {
    return 'trailer' in record ? record.offset + 20 : record.offset + 19;
}

function buildDirectRecordMap(parser, payload) {
    const direct = [
        ...parser.parseCompactGeometryLikeRecords(),
        ...parser.parsePackedGeometryLikeRecords(),
    ].sort((left, right) => left.offset - right.offset);

    const records = new Map();
    for (let index = 0; index < direct.length; index++) {
        const record = direct[index];
        const start = payloadStartOffset(record);
        const end = direct[index + 1]?.offset ?? payload.length;
        records.set(record.id, {
            ...record,
            start,
            end,
            payloadBytes: Math.max(0, end - start),
        });
    }
    return records;
}

function scanShiftedFloats(window, markerIdx, maxShift = 8) {
    const rows = [];
    for (let shift = 1; shift <= maxShift; shift++) {
        const start = markerIdx + shift;
        if (start + 8 > window.length) continue;
        const floats = [];
        for (let offset = start; offset + 8 <= window.length; offset += 8) {
            const value = window.readDoubleBE(offset);
            if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
            floats.push(value);
        }
        if (floats.length < 3) continue;
        rows.push({ shift, floats });
    }
    return rows.sort((left, right) => right.floats.length - left.floats.length || left.shift - right.shift);
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function classifyFloats(floats) {
    const preview = floats.slice(0, 12).map((value) => formatNumber(value));
    const result = { preview, hint: 'generic' };
    if (floats.length >= 9) {
        const p1 = { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 };
        const p2 = { x: floats[3] * 1000, y: floats[4] * 1000, z: floats[5] * 1000 };
        const delta = Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
        result.segment = {
            p1: Object.values(p1).map((value) => formatNumber(value)),
            p2: Object.values(p2).map((value) => formatNumber(value)),
            scalar6mm: formatNumber((floats[6] ?? 0) * 1000),
            scalar7mm: formatNumber((floats[7] ?? 0) * 1000),
            actualDistance: formatNumber(delta),
        };
        if (Math.abs(p1.y - p2.y) < 0.001 && Math.abs(delta - floats[7] * 1000) < 0.01) result.hint = 'segment-like';
    }
    return result;
}

function formatWord(word) {
    return `0x${word.toString(16).padStart(4, '0')}`;
}

function formatBytes(buffer, limit = 48) {
    const preview = [...buffer.subarray(0, limit)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ');
    return buffer.length > limit ? `${preview} ...` : preview;
}

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);

console.log('investigate192 — FTC_07 wrapper endcap anatomy');
console.log('Clean-room basis: compare endcaps 16 and 90 against the stable interior wrapper 51.');
console.log(`\n== ${fileName} ==`);

for (const id of TARGET_IDS) {
    const record = direct.get(id);
    if (!record) {
        console.log(`  wrapper=${id} missing`);
        continue;
    }
    const window = payload.subarray(record.offset, record.end);
    const words = [];
    for (let offset = 0; offset + 2 <= Math.min(window.length, 80); offset += 2) {
        words.push(window.readUInt16BE(offset));
    }
    const markerPositions = [];
    for (let index = 0; index < window.length; index++) {
        if (window[index] === 0x2b || window[index] === 0x2d) markerPositions.push(index);
    }

    console.log(`\nwrapper=${id} offset=${record.offset} span=${window.length} bytes=${record.payloadBytes} refs=[${record.refIds.join(', ')}] markerByte=0x${record.markerByte.toString(16)}`);
    console.log(`  headWords=${words.slice(0, 24).map((word) => formatWord(word)).join(' ')}`);
    console.log(`  headBytes=${formatBytes(window)}`);
    console.log(`  markerPositions=[${markerPositions.join(', ')}]`);

    for (const markerIdx of markerPositions.slice(0, 8)) {
        const rows = scanShiftedFloats(window, markerIdx);
        if (rows.length === 0) {
            console.log(`  marker@${markerIdx}: no shifted float rows`);
            continue;
        }
        console.log(`  marker@${markerIdx}:`);
        for (const row of rows.slice(0, 4)) {
            const classified = classifyFloats(row.floats);
            const segmentText = classified.segment
                ? ` segment p1=(${classified.segment.p1.join(', ')}) p2=(${classified.segment.p2.join(', ')}) scalar6mm=${classified.segment.scalar6mm} scalar7mm=${classified.segment.scalar7mm} actualDistance=${classified.segment.actualDistance}`
                : '';
            console.log(`    shift=+${row.shift} floats=${row.floats.length} hint=${classified.hint}${segmentText} preview=[${classified.preview.join(', ')}]`);
        }
    }
}