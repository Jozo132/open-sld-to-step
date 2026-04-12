#!/usr/bin/env node
/**
 * investigate119.mjs — Face anchors vs global coedge chain
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Map face coedge anchors onto the ordered coedge chain where one exists.
 * 2. Compare anchor positions with every aligned coedge hit inside the raw face payload.
 * 3. Determine whether anchors likely bound contiguous face-local chain spans.
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

function scanPayloadCoedgeHits(buf, face, coedgeIds) {
    const payload = buf.subarray(face.offset + 4, face.offset + 4 + face.dataLength);
    const hits = [];

    for (let byteOffset = 0; byteOffset + 2 <= payload.length; byteOffset += 2) {
        const word = payload.readUInt16BE(byteOffset);
        if (coedgeIds.has(word)) hits.push({ byteOffset, id: word });
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

console.log('=== FACE ANCHORS VS COEDGE CHAIN ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const chain = parser.parseCoedgeChain();
    if (!chain) continue;

    const positionById = new Map(chain.orderedCoedges.map((record, index) => [record.id, index]));
    const coedgeIds = new Set(chain.orderedCoedges.map((record) => record.id));
    const faces = parser.parseFaceRecords().filter((face) => face.coedgeAnchorAId !== null || face.coedgeAnchorBId !== null);

    console.log(`\n${fileName}`);
    console.log(`  chainLength=${chain.orderedCoedges.length} anchoredFaces=${faces.length}`);

    let facesWithBothAnchors = 0;
    let facesWhoseHitsStayBetweenAnchors = 0;

    for (const face of faces) {
        const hits = scanPayloadCoedgeHits(extracted.data, face, coedgeIds);
        const hitPositions = hits.map((hit) => ({ ...hit, index: positionById.get(hit.id) ?? null }));
        const aIndex = face.coedgeAnchorAId !== null ? positionById.get(face.coedgeAnchorAId) ?? null : null;
        const bIndex = face.coedgeAnchorBId !== null ? positionById.get(face.coedgeAnchorBId) ?? null : null;

        let hitsStayBetweenAnchors = false;
        if (aIndex !== null && bIndex !== null) {
            facesWithBothAnchors++;
            const indexedHits = hitPositions.filter((hit) => hit.index !== null);
            hitsStayBetweenAnchors = indexedHits.length > 0 && indexedHits.every((hit) => betweenLinear(aIndex, bIndex, hit.index));
            if (hitsStayBetweenAnchors) facesWhoseHitsStayBetweenAnchors++;
        }

        console.log(
            `  face=${face.id} a=${face.coedgeAnchorAId ?? '-'}@${aIndex ?? '-'} b=${face.coedgeAnchorBId ?? '-'}@${bIndex ?? '-'} hits=${JSON.stringify(hitPositions.slice(0, 12))} between=${hitsStayBetweenAnchors}`,
        );
    }

    console.log(`  facesWithBothAnchors=${facesWithBothAnchors} hitsBetweenAnchors=${facesWhoseHitsStayBetweenAnchors}`);
}