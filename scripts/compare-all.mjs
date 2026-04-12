#!/usr/bin/env node
/**
 * compare-all.mjs — Compare all generated STEP files against references.
 *
 * Output:
 *   1. Summary table — one row per file, columns for each score metric + overall
 *   2. Full detailed comparison for each file below the table
 *
 * Usage:  node scripts/compare-all.mjs
 *         npm run compare-all
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareStepFiles, SCORE_WEIGHTS } from './compare-step.mjs';

const OUTPUT_DIR = path.resolve('output');
const REF_CTC = path.resolve('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions');
const REF_FTC = path.resolve('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/FTC Definitions');
export const PERFORMANCE_RESULTS_PATH = path.resolve('performance-results.md');

const scoreKeys = Object.keys(SCORE_WEIGHTS); // Planes, Cylinders, Cones, Faces, HolesExact, InnerLoops, Vertices, Circles

// Column widths
const nameW = 18;
const colW = 10;
const sepChar = '─';

// Short label for file: nist_ctc_01_asme1_rd_sw1802.stp → CTC_01
function shortName(f) {
    const m = f.match(/nist_(ctc|ftc)_(\d+)/);
    return m ? `${m[1].toUpperCase()}_${m[2]}` : f.slice(0, nameW);
}

// Format percentage cell with matched/total
function fmtCell(data) {
    if (!data) return '  —  '.padStart(colW);
    return `${data.pct.toFixed(0)}%`.padStart(colW);
}

// Format matched/total below the percentage
function fmtRatio(data) {
    if (!data) return ''.padStart(colW);
    return `${data.matched}/${data.total}`.padStart(colW);
}

function padCell(value, width, align = 'left') {
    return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

function renderAsciiTable(title, headers, rows, alignments) {
    const widths = headers.map((header, index) => {
        const rowMax = rows.reduce((max, row) => Math.max(max, row[index].length), 0);
        return Math.max(header.length, rowMax);
    });

    const border = `+${widths.map(width => '-'.repeat(width + 2)).join('+')}+`;
    const headerRow = `| ${headers.map((header, index) => padCell(header, widths[index], alignments[index])).join(' | ')} |`;
    const dataRows = rows.map(row => `| ${row.map((cell, index) => padCell(cell, widths[index], alignments[index])).join(' | ')} |`);

    return [
        title,
        border,
        headerRow,
        border,
        ...dataRows,
        border,
    ].join('\n');
}

function summarizeResults(results) {
    const sums = {};
    const counts = {};
    for (const key of scoreKeys) {
        sums[key] = 0;
        counts[key] = 0;
    }

    let overallSum = 0;
    for (const result of results) {
        for (const key of scoreKeys) {
            const data = result.scores[key];
            if (!data) continue;
            sums[key] += data.pct;
            counts[key]++;
        }
        overallSum += Number(result.overall);
    }

    const averages = {};
    for (const key of scoreKeys) {
        averages[key] = counts[key] > 0 ? sums[key] / counts[key] : 0;
    }

    return {
        averages,
        averageOverall: results.length > 0 ? overallSum / results.length : 0,
    };
}

export function collectComparisonPairs() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];

    const genFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.stp')).sort();
    const pairs = [];

    for (const genFile of genFiles) {
        const match = genFile.match(/^(nist_(?:ctc|ftc)_\d+_asme1_r[a-z])_sw\d+\.stp$/);
        if (!match) continue;
        const refBase = match[1] + '.stp';
        const isCtc = genFile.startsWith('nist_ctc');
        const refDir = isCtc ? REF_CTC : REF_FTC;
        const refPath = path.join(refDir, refBase);
        const genPath = path.join(OUTPUT_DIR, genFile);
        if (!fs.existsSync(refPath)) continue;
        pairs.push({ genFile, refBase, genPath, refPath });
    }

    return pairs;
}

export function compareAllFiles() {
    const pairs = collectComparisonPairs();
    const skipped = [];
    const results = [];

    for (const genFile of fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.stp')).sort() : []) {
        const match = genFile.match(/^(nist_(?:ctc|ftc)_\d+_asme1_r[a-z])_sw\d+\.stp$/);
        if (!match) continue;
        const refBase = match[1] + '.stp';
        const isCtc = genFile.startsWith('nist_ctc');
        const refDir = isCtc ? REF_CTC : REF_FTC;
        const refPath = path.join(refDir, refBase);
        if (!fs.existsSync(refPath)) {
            skipped.push(genFile);
        }
    }

    for (const { genFile, refBase, genPath, refPath } of pairs) {
        const genText = fs.readFileSync(genPath, 'utf8');
        const refText = fs.readFileSync(refPath, 'utf8');
        const result = compareStepFiles(genText, refText, genFile, refBase);
        results.push({ genFile, refBase, ...result });
    }

    return { results, skipped };
}

export function renderMarkdownSummary(results) {
    const { averages, averageOverall } = summarizeResults(results);
    const percentHeader = ['File', ...scoreKeys, 'OVERALL'];
    const percentRows = results.map(result => {
        const cells = scoreKeys.map(key => {
            const data = result.scores[key];
            return data ? `${data.pct.toFixed(0)}%` : '—';
        });
        return [shortName(result.genFile), ...cells, `${Number(result.overall).toFixed(1)}%`];
    });
    percentRows.push([
        'AVERAGE',
        ...scoreKeys.map(key => `${averages[key].toFixed(1)}%`),
        `${averageOverall.toFixed(1)}%`,
    ]);

    const ratioHeader = ['File', ...scoreKeys];
    const ratioRows = results.map(result => [
        shortName(result.genFile),
        ...scoreKeys.map(key => {
            const data = result.scores[key];
            return data ? `${data.matched}/${data.total}` : '—';
        }),
    ]);

    const percentAlignments = ['left', ...percentHeader.slice(1).map(() => 'right')];
    const ratioAlignments = ['left', ...ratioHeader.slice(1).map(() => 'right')];
    const summaryTable = renderAsciiTable('STEP COMPARISON -- ALL FILES SUMMARY', percentHeader, percentRows, percentAlignments);
    const ratioTable = renderAsciiTable('STEP COMPARISON -- MATCH COUNTS', ratioHeader, ratioRows, ratioAlignments);

    const lines = [
        '# Performance Results',
        '',
        'Auto-generated by `npm run compare-all` and refreshed by `npm test` when comparison inputs are available.',
        'This file is intended to stay tracked in git so score changes show up in diffs.',
        '',
        '## Summary',
        '',
        '```text',
        summaryTable,
        '```',
        '',
        '## Match Counts',
        '',
        '```text',
        ratioTable,
        '```',
        '',
    ];

    return lines.join('\n');
}

export function writePerformanceResults(results, filePath = PERFORMANCE_RESULTS_PATH) {
    fs.writeFileSync(filePath, renderMarkdownSummary(results), 'utf8');
}

export function renderConsoleSummary(results) {
    const { averages, averageOverall } = summarizeResults(results);

    console.log('\n' + '═'.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));
    console.log('  STEP COMPARISON — ALL FILES SUMMARY');
    console.log('═'.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));

    const hdrCols = scoreKeys.map(k => k.padStart(colW)).join(' ');
    console.log(`${'File'.padEnd(nameW)}  ${hdrCols} ${'OVERALL'.padStart(colW)}`);
    console.log(sepChar.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));

    for (const result of results) {
        const name = shortName(result.genFile).padEnd(nameW);
        const cells = scoreKeys.map(key => fmtCell(result.scores[key])).join(' ');
        console.log(`${name}  ${cells} ${(`${Number(result.overall).toFixed(1)}%`).padStart(colW)}`);
    }

    console.log(sepChar.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));
    for (const result of results) {
        const name = shortName(result.genFile).padEnd(nameW);
        const cells = scoreKeys.map(key => fmtRatio(result.scores[key])).join(' ');
        console.log(`${name}  ${cells}`);
    }

    console.log(sepChar.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));
    const avgCells = scoreKeys.map(key => `${averages[key].toFixed(1)}%`.padStart(colW)).join(' ');
    console.log(`${'AVERAGE'.padEnd(nameW)}  ${avgCells} ${(`${averageOverall.toFixed(1)}%`).padStart(colW)}`);
    console.log('═'.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));
}

function renderDetailedOutput(results) {
    console.log('\n\n');
    for (const result of results) {
        console.log('╔' + '═'.repeat(70) + '╗');
        console.log(`║  ${result.genFile}  ↔  ${result.refBase}`.padEnd(71) + '║');
        console.log('╚' + '═'.repeat(70) + '╝');
        console.log(result.output);
        console.log('\n');
    }
}

export function runCompareAllCli() {
    const { results, skipped } = compareAllFiles();

    for (const genFile of skipped) {
        console.log(`Skipping ${genFile} — no reference`);
    }

    if (results.length === 0) {
        console.log('No generated STEP/reference pairs found.');
        return;
    }

    renderConsoleSummary(results);
    writePerformanceResults(results);
    console.log(`\nUpdated ${path.basename(PERFORMANCE_RESULTS_PATH)}`);
    renderDetailedOutput(results);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    runCompareAllCli();
}
