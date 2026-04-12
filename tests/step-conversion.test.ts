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
const ctc01Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ctc_01_asme1_rd_sw1802.sldprt',
);
const ctc04Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ctc_04_asme1_rd_sw1802.sldprt',
);
const ftc11Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ftc_11_asme1_rb_sw1802.sldprt',
);

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

    it('parses schema metadata from a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const metadata = parser.parseSchemaMetadata();

        expect(metadata).not.toBeNull();
        if (!metadata) return;

        expect(metadata.schemaId).toContain('SCH_');
        expect(metadata.fieldDefinitions.length).toBeGreaterThan(0);
        expect(metadata.namedClasses.length).toBeGreaterThan(0);
        expect(metadata.metadataEndOffset).toBeGreaterThan(metadata.schemaTerminatorOffset);
        expect(metadata.firstSentinelOffset).not.toBeNull();
        expect((metadata.firstSentinelOffset ?? 0)).toBeGreaterThan(metadata.metadataEndOffset);
        expect(metadata.firstEntityHeader).not.toBeNull();
    });

    it('detects the first pre-sentinel entity record across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const metadata = parser.parseSchemaMetadata();

            expect(metadata).not.toBeNull();
            if (!metadata) continue;

            expect(metadata.firstSentinelOffset).not.toBeNull();
            expect(metadata.firstEntityOffset).not.toBeNull();
            expect(metadata.firstEntityHeader).not.toBeNull();
            expect(metadata.firstEntityHeader?.offset).toBe(metadata.firstEntityOffset);
            expect(metadata.firstEntityOffset!).toBeLessThan(metadata.firstSentinelOffset!);
            expect(metadata.firstEntityOffset!).toBeGreaterThanOrEqual(metadata.metadataEndOffset);
        }
    });

    it('parses sentinel-aligned linear records across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const metadata = parser.parseSchemaMetadata();
            const records = parser.parseSentinelAlignedEntities();

            expect(records.length).toBeGreaterThan(0);
            const firstHeaderIsSentinelAdjacent = metadata?.firstSentinelOffset !== null &&
                metadata?.firstSentinelOffset !== undefined &&
                metadata?.firstEntityOffset !== null &&
                metadata.firstSentinelOffset - metadata.firstEntityOffset <= 18;
            if (firstHeaderIsSentinelAdjacent) {
                expect(records.some(record => record.sentinelOffset === metadata.firstSentinelOffset)).toBe(true);
            }
        }
    });

    it('finds both compact and packed sentinel record forms in CTC_01', () => {
        if (!hasSamples) return;
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const records = parser.parseSentinelAlignedEntities();

        expect(records.some(record => record.role === 'embedded-data' && record.header.type === 16)).toBe(true);
        expect(records.some(record => record.role === 'terminator' && record.header.type === 18)).toBe(true);
    });

    it('decodes coedge and gap-point linkage across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const coedges = parser.parseCoedgeRecords();
            const points = parser.parseGapPointRecords();
            const coedgeIds = new Set(coedges.map(record => record.id));
            const pointIds = new Set(points.map(record => record.id));
            const prevResolved = coedges.filter(record => coedgeIds.has(record.prevCoedgeId)).length;
            const nextResolved = coedges.filter(record => coedgeIds.has(record.nextCoedgeId)).length;
            const vertexResolved = coedges.filter(record => pointIds.has(record.vertexPointId)).length;

            expect(coedgeIds.size).toBe(coedges.length);
            expect(pointIds.size).toBe(points.length);

            if (basename(filePath).toLowerCase() === 'nist_ftc_11_asme1_rb_sw1802.sldprt') {
                expect(coedges).toHaveLength(0);
                expect(points).toHaveLength(0);
                continue;
            }

            expect(coedges.length).toBeGreaterThan(0);
            expect(points.length).toBeGreaterThan(0);
            expect(prevResolved).toBe(coedges.length - 1);
            expect(nextResolved).toBe(coedges.length - 1);
            expect(vertexResolved).toBe(points.length);
        }
    });

    it('stabilizes the first decoded CTC_01 coedge and point links', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const coedges = parser.parseCoedgeRecords();
        const points = parser.parseGapPointRecords();

        expect(coedges.slice(0, 4)).toMatchObject([
            { id: 52, curveLikeId: 59, prevCoedgeId: 14, nextCoedgeId: 60, vertexPointId: 46 },
            { id: 60, curveLikeId: 67, prevCoedgeId: 52, nextCoedgeId: 68, vertexPointId: 69 },
            { id: 68, curveLikeId: 72, prevCoedgeId: 60, nextCoedgeId: 73, vertexPointId: 70 },
            { id: 73, curveLikeId: 75, prevCoedgeId: 68, nextCoedgeId: 76, vertexPointId: 71 },
        ]);
        expect(points.slice(0, 4)).toMatchObject([
            { id: 46, nextCoedgeId: 52, nextPointId: 69, prevPointId: 11 },
            { id: 71, nextCoedgeId: 73, nextPointId: 74, prevPointId: 70 },
            { id: 74, nextCoedgeId: 76, nextPointId: 77, prevPointId: 71 },
            { id: 77, nextCoedgeId: 79, nextPointId: 80, prevPointId: 74 },
        ]);
    });

    it('reconstructs a single ordered coedge chain across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const coedges = parser.parseCoedgeRecords();
            const chain = parser.parseCoedgeChain();

            if (basename(filePath).toLowerCase() === 'nist_ftc_11_asme1_rb_sw1802.sldprt') {
                expect(chain).toBeNull();
                continue;
            }

            expect(chain).not.toBeNull();
            if (!chain) continue;

            expect(chain.orderedCoedges).toHaveLength(coedges.length);
            expect(chain.headCoedgeId).toBe(chain.orderedCoedges[0].id);
            expect(chain.tailCoedgeId).toBe(chain.orderedCoedges[chain.orderedCoedges.length - 1].id);
            expect(chain.terminalNextId).toBe(1);
        }
    });

    it('stabilizes the CTC_01 coedge chain endpoints', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const chain = parser.parseCoedgeChain();

        expect(chain).not.toBeNull();
        if (!chain) return;

        expect(chain.headCoedgeId).toBe(52);
        expect(chain.tailCoedgeId).toBe(710);
        expect(chain.terminalPrevId).toBe(14);
        expect(chain.terminalNextId).toBe(1);
        expect(chain.orderedCoedges.slice(0, 4).map(record => record.id)).toEqual([52, 60, 68, 73]);
        expect(chain.orderedCoedges.slice(-4).map(record => record.id)).toEqual([701, 704, 707, 710]);
    });

    it('decodes compact type-16 edge records across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const edges = parser.parseEdgeRecords();

            expect(edges.length).toBeGreaterThan(0);
            expect(new Set(edges.map(record => record.id)).size).toBe(edges.length);
        }
    });

    it('reconstructs ordered type-16 components across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const edges = parser.parseEdgeRecords();
            const components = parser.parseEdgeComponents();
            const edgeIds = new Set(edges.map(record => record.id));
            const prevResolved = edges.filter(record => edgeIds.has(record.prevEdgeId)).length;
            const nextResolved = edges.filter(record => edgeIds.has(record.nextEdgeId)).length;
            const totalEdgesInComponents = components.reduce((sum, component) => sum + component.orderedEdges.length, 0);
            const fileName = basename(filePath).toLowerCase();

            expect(totalEdgesInComponents).toBe(edges.length);
            expect(prevResolved).toBe(edges.length - components.length);
            expect(nextResolved).toBe(edges.length - components.length);

            if (fileName === 'nist_ctc_01_asme1_rd_sw1802.sldprt') {
                expect(components).toHaveLength(12);
                continue;
            }

            if (fileName === 'nist_ctc_03_asme1_rc_sw1802.sldprt') {
                expect(components).toHaveLength(4);
                continue;
            }

            expect(components).toHaveLength(1);
            expect(components[0].terminalNextId).toBe(1);
        }
    });

    it('stabilizes the FTC_11 type-16 component chain', () => {
        if (!ftc11Path) return;

        const buf = readFileSync(ftc11Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const edges = parser.parseEdgeRecords();
        const components = parser.parseEdgeComponents();

        expect(edges.map(record => record.id)).toEqual([49, 53, 57, 62, 65]);
        expect(components).toHaveLength(1);
        expect(components[0].headEdgeId).toBe(49);
        expect(components[0].tailEdgeId).toBe(65);
        expect(components[0].terminalPrevId).toBe(13);
        expect(components[0].terminalNextId).toBe(1);
        expect(components[0].orderedEdges.map(record => record.id)).toEqual([49, 53, 57, 62, 65]);
    });

    it('reconstructs ordered type-16 component chains across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const components = parser.parseEdgeComponents();
            const chains = parser.parseEdgeComponentChains();
            const totalComponentsInChains = chains.reduce((sum, chain) => sum + chain.orderedComponents.length, 0);
            const fileName = basename(filePath).toLowerCase();

            expect(totalComponentsInChains).toBe(components.length);

            if (fileName === 'nist_ctc_01_asme1_rd_sw1802.sldprt') {
                expect(chains).toHaveLength(1);
                expect(chains[0].orderedComponents).toHaveLength(12);
                expect(chains[0].terminalPrevId).toBe(13);
                expect(chains[0].terminalNextId).toBe(1);
                continue;
            }

            if (fileName === 'nist_ctc_03_asme1_rc_sw1802.sldprt') {
                expect(chains).toHaveLength(4);
                expect(chains.every(chain => chain.orderedComponents.length === 1)).toBe(true);
                continue;
            }

            expect(chains).toHaveLength(1);
            expect(chains[0].orderedComponents).toHaveLength(1);
        }
    });

    it('stabilizes the CTC_01 type-16 component chain order', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const chains = parser.parseEdgeComponentChains();

        expect(chains).toHaveLength(1);
        expect(chains[0].headEdgeId).toBe(49);
        expect(chains[0].tailEdgeId).toBe(57);
        expect(chains[0].orderedComponents.map(component => component.headEdgeId)).toEqual([
            49, 1175, 1504, 1524, 1385, 1410, 1724, 1395, 1636, 1750, 1150, 1100,
        ]);
        expect(chains[0].orderedComponents.map(component => component.tailEdgeId)).toEqual([
            1174, 1499, 1328, 1538, 1409, 1731, 1394, 1656, 3514, 1158, 1105, 57,
        ]);
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

    it('recovers FTC_11 as a reusable axisymmetric ring model', () => {
        if (!ftc11Path) return;

        const buf = readFileSync(ftc11Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        expect(model.surfaces.filter(s => s.surfaceType === 'plane')).toHaveLength(2);
        expect(model.surfaces.filter(s => s.surfaceType === 'cylinder')).toHaveLength(2);
        expect(model.surfaces.filter(s => s.surfaceType === 'torus')).toHaveLength(2);
        expect(model.faces).toHaveLength(6);
        expect(model.loops).toHaveLength(12);
        expect(model.edges).toHaveLength(6);
        expect(model.curves.filter(c => c.curveType === 'circle')).toHaveLength(6);
    });

    it('infers CTC_04 apex cones from coaxial cylinder transitions', () => {
        if (!ctc04Path) return;

        const buf = readFileSync(ctc04Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        // Regression target from clean-room analysis: 12 reference apex cones
        // can be recovered from repeated 5mm -> 10mm coaxial cylinder steps.
        expect(model.surfaces.filter(s => s.surfaceType === 'cone').length).toBeGreaterThanOrEqual(12);
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
