#!/usr/bin/env node
/**
 * update-performance-results.mjs — Refresh the tracked performance summary.
 *
 * This is intentionally quiet enough to run from npm posttest. It skips
 * cleanly when generated STEP files or reference models are unavailable.
 */
import path from 'node:path';
import { compareAllFiles, PERFORMANCE_RESULTS_PATH, writePerformanceResults } from './compare-all.mjs';

const { results } = compareAllFiles();

if (results.length === 0) {
    console.log('Skipping performance-results.md refresh — no generated STEP/reference pairs found.');
    process.exit(0);
}

writePerformanceResults(results);
console.log(`Updated ${path.basename(PERFORMANCE_RESULTS_PATH)}`);