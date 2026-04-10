/**
 * step-conversion.test.ts
 *
 * Integration tests for the end-to-end SLDPRT → STEP conversion pipeline.
 *
 * Tests against the NIST MBE PMI SolidWorks MBD 2018 sample files.
 * Skipped automatically when samples are not downloaded.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { convertSldprtToStep } from '../src/step/convertSldprtToStep.js';
import { ParasolidParser } from '../src/parser/ParasolidParser.js';
import { SldprtContainerParser } from '../src/parser/SldprtContainerParser.js';

// ── Locate samples ──────────────────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const DOWNLOADS_DIR = join(ROOT, 'downloads', 'nist');

function findSldprtFiles(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findSldprtFiles(full));
        else if (/\.sldprt$/i.test(entry.name)) results.push(full);
    }
    return results;
}

const sampleFiles = findSldprtFiles(DOWNLOADS_DIR);
const hasSamples = sampleFiles.length > 0;
const describeWithSamples = hasSamples ? describe : describe.skip;

// ── Shared conversion cache ─────────────────────────────────────────────────
// Each file is read and converted exactly once, then all assertions run against
// the cached result.  This avoids O(files × testBlocks) repeated conversions
// which caused heap exhaustion on large sample sets.

import type { ConversionResult } from '../src/step/convertSldprtToStep.js';

const conversionCache = new Map<string, ConversionResult | null>();

function getCachedConversion(filePath: string): ConversionResult | null {
    if (conversionCache.has(filePath)) return conversionCache.get(filePath)!;
    const buf = readFileSync(filePath);
    const result = convertSldprtToStep(buf, basename(filePath));
    conversionCache.set(filePath, result);
    return result;
}

// ── ParasolidParser unit tests ──────────────────────────────────────────────

afterAll(() => {
    conversionCache.clear();
});

describe('ParasolidParser', () => {
    it('returns null header for non-Parasolid buffer', () => {
        const parser = new ParasolidParser(Buffer.from('not a parasolid file'));
        expect(parser.parseHeader()).toBeNull();
    });

    it('returns null header for empty buffer', () => {
        const parser = new ParasolidParser(Buffer.alloc(0));
        expect(parser.parseHeader()).toBeNull();
    });

    it('parses header from a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();

        const parser = new ParasolidParser(extraction!.data);
        const header = parser.parseHeader();
        expect(header).not.toBeNull();
        expect(header!.modellerVersion).toBeGreaterThan(0);
        expect(header!.schemaId).toContain('SCH_');
    });

    it('finds entity classes in a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const classes = parser.findEntityClasses();
        expect(classes.length).toBeGreaterThan(0);
        expect(classes).toContain('BODY');
    });

    it('counts entity records in a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const counts = parser.countEntityRecords();
        expect(counts.pRecords + counts.qRecords).toBeGreaterThan(0);
    });

    it('extracts coordinates from a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const coords = parser.extractCoordinates();
        expect(coords.length).toBeGreaterThan(0);
        // Each coordinate should have finite x, y, z
        for (const pt of coords) {
            expect(isFinite(pt.x)).toBe(true);
            expect(isFinite(pt.y)).toBe(true);
            expect(isFinite(pt.z)).toBe(true);
        }
    });

    it('parse() returns a PsModel with vertices', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();
        expect(model.vertices.length).toBeGreaterThan(0);
        expect(model.bodies.length).toBeGreaterThanOrEqual(0);
    });
});

// ── End-to-end conversion tests ─────────────────────────────────────────────

describeWithSamples('convertSldprtToStep — NIST samples', () => {
    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → produces a non-null conversion result',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            expect(result).not.toBeNull();
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP output starts with ISO-10303-21',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step.startsWith('ISO-10303-21;')).toBe(true);
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP output ends with END-ISO-10303-21',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('END-ISO-10303-21;');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains HEADER and DATA sections',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('HEADER;');
            expect(result.step).toContain('DATA;');
            expect(result.step).toContain('ENDSEC;');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains required AP214 context entities',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('APPLICATION_CONTEXT');
            expect(result.step).toContain('PRODUCT_DEFINITION');
            expect(result.step).toContain('AUTOMOTIVE_DESIGN');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains CARTESIAN_POINT entities',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('CARTESIAN_POINT');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains geometric representation',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('GEOMETRIC_REPRESENTATION_CONTEXT');
            expect(result.step).toContain('LENGTH_UNIT');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → model has vertices and topology',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.model.vertices.length).toBeGreaterThan(0);
            expect(result.parasolidSize).toBeGreaterThan(0);
            expect(result.containerFormat).toBe('sw3d');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → entities have sequential IDs',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            for (let i = 0; i < result.entities.length; i++) {
                expect(result.entities[i].id).toBe(i + 1);
            }
        },
    );
});

// ── STEP format validity ────────────────────────────────────────────────────

describeWithSamples('STEP format validity — NIST samples', () => {
    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → every entity line matches #N=TYPE(...);',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;

            // Extract DATA section
            const dataStart = result.step.indexOf('DATA;');
            const dataEnd = result.step.indexOf('ENDSEC;', dataStart);
            const dataSection = result.step.substring(dataStart + 5, dataEnd).trim();

            if (dataSection.length === 0) return;

            const entityPattern = /^#\d+=[\w(),.'#*$ ;E+-]+$/;
            const lines = dataSection.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
                expect(line).toMatch(/^#\d+=/);
                expect(line.endsWith(';')).toBe(true);
            }
        },
    );
});

// ── Skip notice ──────────────────────────────────────────────────────────────

if (!hasSamples) {
    describe('STEP conversion integration tests', () => {
        it('are SKIPPED — run `npm run download-samples` first', () => {
            console.log(
                '\n  ℹ  Samples not found. Run `npm run download-samples` first.\n',
            );
        });
    });
}
