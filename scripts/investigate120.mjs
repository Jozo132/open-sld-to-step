#!/usr/bin/env node
/**
 * investigate120.mjs — Face edge anchors vs ordered edge chains
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Map face edge anchors onto decoded edge components and component chains.
 * 2. Compare anchor positions with every aligned edge hit inside raw face payloads.
 * 3. Determine whether face payloads are better modelled as edge spans than coedge spans.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);

function findSldprtFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findSldprtFiles(fullPath));
        else if (/\.sldprt$/i.test(entry.name)) results.push(fullPath);
    }
    return results;
}

function scanPayloadEdgeHits(buf, face, edgeIds) {
    const payload = buf.subarray(face.offset + 4, face.offset + 4 + face.dataLength);
    const hits = [];

    for (let byteOffset = 0; byteOffset + 2 <= payload.length; byteOffset += 2) {
        const word = payload.readUInt16BE(byteOffset);
        if (edgeIds.has(word)) hits.push({ byteOffset, id: word });
    }

    return hits;
}

function betweenLinear(a, b, x) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return x >= lo && x <= hi;
}

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== FACE EDGE ANCHORS VS EDGE CHAINS ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const faces = parser.parseFaceRecords().filter((face) => face.edgeAnchorAId !== null || face.edgeAnchorBId !== null);
    const edges = parser.parseEdgeRecords();
    if (faces.length === 0 || edges.length === 0) continue;

    const components = parser.parseEdgeComponents();
    const chains = parser.parseEdgeComponentChains();
    const edgeIds = new Set(edges.map((record) => record.id));

    const componentByEdgeId = new Map();
    components.forEach((component, componentIndex) => {
        component.orderedEdges.forEach((edge, edgeIndex) => {
            componentByEdgeId.set(edge.id, { componentIndex, edgeIndex });
        });
    });

    const chainByEdgeId = new Map();
    chains.forEach((chain, chainIndex) => {
        let linearIndex = 0;
        chain.orderedComponents.forEach((component, componentIndex) => {
            component.orderedEdges.forEach((edge, edgeIndex) => {
                chainByEdgeId.set(edge.id, { chainIndex, componentIndex, edgeIndex, linearIndex });
                linearIndex++;
            });
        });
    });

    console.log(`\n${fileName}`);
    console.log(`  faces=${faces.length} edges=${edges.length} components=${components.length} chains=${chains.length}`);

    let facesWithBothAnchors = 0;
    let sameChainAnchors = 0;
    let hitsBetweenAnchors = 0;
    let sameComponentAnchors = 0;

    for (const face of faces) {
        const hits = scanPayloadEdgeHits(extracted.data, face, edgeIds);
        const hitPositions = hits.map((hit) => ({ ...hit, pos: chainByEdgeId.get(hit.id) ?? null }));
        const aPos = face.edgeAnchorAId !== null ? chainByEdgeId.get(face.edgeAnchorAId) ?? null : null;
        const bPos = face.edgeAnchorBId !== null ? chainByEdgeId.get(face.edgeAnchorBId) ?? null : null;

        let sameChain = false;
        let sameComponent = false;
        let between = false;
        if (aPos && bPos) {
            facesWithBothAnchors++;
            sameChain = aPos.chainIndex === bPos.chainIndex;
            sameComponent = aPos.componentIndex === bPos.componentIndex;
            if (sameChain) sameChainAnchors++;
            if (sameComponent) sameComponentAnchors++;

            const indexedHits = hitPositions.filter((hit) => hit.pos && hit.pos.chainIndex === aPos.chainIndex);
            between = sameChain && indexedHits.length > 0 && indexedHits.every((hit) => betweenLinear(aPos.linearIndex, bPos.linearIndex, hit.pos.linearIndex));
            if (between) hitsBetweenAnchors++;
        }

        console.log(
            `  face=${face.id} a=${face.edgeAnchorAId ?? '-'}@${aPos ? `${aPos.chainIndex}/${aPos.componentIndex}/${aPos.linearIndex}` : '-'} b=${face.edgeAnchorBId ?? '-'}@${bPos ? `${bPos.chainIndex}/${bPos.componentIndex}/${bPos.linearIndex}` : '-'} sameChain=${sameChain} sameComponent=${sameComponent} between=${between} hits=${JSON.stringify(hitPositions.slice(0, 12))}`,
        );
    }

    console.log(`  facesWithBothAnchors=${facesWithBothAnchors} sameChainAnchors=${sameChainAnchors} sameComponentAnchors=${sameComponentAnchors} hitsBetweenAnchors=${hitsBetweenAnchors}`);
}