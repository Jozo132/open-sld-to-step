#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);
const isWatchMode = forwardedArgs.includes('--watch') || forwardedArgs.includes('-w');

function hasBun() {
    const probe = spawnSync('bun', ['--version'], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
    });
    return probe.status === 0;
}

function collapseBlankLines(lines) {
    const collapsed = [];
    let previousBlank = true;

    for (const line of lines) {
        const isBlank = line.trim().length === 0;
        if (isBlank && previousBlank) continue;
        collapsed.push(line);
        previousBlank = isBlank;
    }

    while (collapsed.length > 0 && collapsed[0].trim().length === 0) {
        collapsed.shift();
    }
    while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim().length === 0) {
        collapsed.pop();
    }

    return collapsed;
}

function isBunSummaryLine(line) {
    const trimmed = line.trimStart();
    return /^\d+\s+(pass|skip|todo|fail)\b/.test(trimmed)
        || /^\d+\s+expect\(\) calls\b/.test(trimmed)
        || /^Ran\s+\d+\s+tests?\s+across\s+\d+\s+files?\./.test(trimmed);
}

function extractBunSummary(stdout) {
    const lines = stdout.replace(/\r\n/g, '\n').split('\n');
    let summaryEnd = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
        if (/^Ran\s+\d+\s+tests?\s+across\s+\d+\s+files?\./.test(lines[index].trimStart())) {
            summaryEnd = index;
            break;
        }
    }

    if (summaryEnd < 0) return '';

    let summaryStart = summaryEnd;
    while (summaryStart > 0) {
        const previousLine = lines[summaryStart - 1];
        if (previousLine.trim().length === 0 || isBunSummaryLine(previousLine)) {
            summaryStart--;
            continue;
        }
        break;
    }

    return collapseBlankLines(lines.slice(summaryStart, summaryEnd + 1)).join('\n');
}

function formatBunOutput(stdout, status) {
    const lines = stdout.replace(/\r\n/g, '\n').split('\n');

    if (status === 0) {
        const summary = extractBunSummary(stdout);
        return summary ? `OK\n${summary}\n` : 'OK\n';
    }

    const filtered = collapseBlankLines(lines.filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('✓ ')
            && !trimmed.startsWith('» ')
            && !/^\((pass|skip|todo)\)\s/.test(trimmed);
    })).join('\n');

    return filtered.length > 0 ? `${filtered}\n` : '';
}

const useBun = hasBun();
const command = useBun ? 'bun' : 'node';
const args = useBun
    ? ['test', ...forwardedArgs]
    : [
        '--max-old-space-size=1024',
        '--experimental-vm-modules',
        './node_modules/jest/bin/jest.js',
        ...forwardedArgs,
    ];

if (useBun) {
    console.log('Using Bun test runner');
} else {
    console.log('Bun unavailable; using Jest fallback');
}

const shouldFilterBunOutput = useBun && !isWatchMode;
const result = shouldFilterBunOutput
    ? spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === 'win32',
    })
    : spawnSync(command, args, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

if (result.error) {
    throw result.error;
}

if (shouldFilterBunOutput) {
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const status = typeof result.status === 'number' ? result.status : 1;
    const combinedOutput = stdout && stderr
        ? `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}`
        : `${stdout}${stderr}`;
    const formattedOutput = formatBunOutput(combinedOutput, status);

    if (formattedOutput) {
        process.stdout.write(formattedOutput);
    }
}

if (typeof result.status === 'number') {
    process.exit(result.status);
}

process.exit(1);