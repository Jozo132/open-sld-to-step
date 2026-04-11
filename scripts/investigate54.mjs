#!/usr/bin/env node
/**
 * investigate54.mjs — Compare vertex positions between working/broken files
 */
import fs from 'fs';
import path from 'path';

const outputDir = './output';
const refDir1 = './downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions';
const refDir2 = './downloads/nist/NIST-FTC-CTC-PMI-CAD-models/FTC Definitions';

function getRefFile(base) {
    const p1 = path.join(refDir1, base + '.stp');
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(refDir2, base + '.stp');
    if (fs.existsSync(p2)) return p2;
    return null;
}

function parseVertices(stepContent) {
    const re = /CARTESIAN_POINT\('([^']*)'\s*,\s*\(([^)]+)\)\)/g;
    const vertices = [];
    let m;
    while ((m = re.exec(stepContent)) !== null) {
        const coords = m[2].split(',').map(s => parseFloat(s.trim()));
        if (coords.length === 3 && coords.every(c => isFinite(c))) {
            vertices.push({ label: m[1], x: coords[0], y: coords[1], z: coords[2] });
        }
    }
    return vertices;
}

function vertexStats(vertices) {
    if (vertices.length === 0) return 'no vertices';
    const xs = vertices.map(v => v.x);
    const ys = vertices.map(v => v.y);
    const zs = vertices.map(v => v.z);
    return {
        count: vertices.length,
        x: { min: Math.min(...xs).toFixed(2), max: Math.max(...xs).toFixed(2) },
        y: { min: Math.min(...ys).toFixed(2), max: Math.max(...ys).toFixed(2) },
        z: { min: Math.min(...zs).toFixed(2), max: Math.max(...zs).toFixed(2) },
        sample: vertices.slice(0, 5).map(v => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`),
    };
}

for (const base of ['nist_ctc_01_asme1_rd', 'nist_ctc_05_asme1_rd', 'nist_ftc_06_asme1_rd', 'nist_ctc_03_asme1_rc']) {
    const genFile = path.join(outputDir, base + '_sw1802.stp');
    const refFile = getRefFile(base);

    if (!fs.existsSync(genFile) || !refFile) {
        console.log(`\n--- ${base}: missing file(s) ---`);
        continue;
    }

    const genVerts = parseVertices(fs.readFileSync(genFile, 'utf8'));
    const refVerts = parseVertices(fs.readFileSync(refFile, 'utf8'));

    console.log(`\n=== ${base} ===`);
    console.log(`Gen: ${JSON.stringify(vertexStats(genVerts))}`);
    console.log(`Ref: ${JSON.stringify(vertexStats(refVerts))}`);
    
    let matched1 = 0;
    for (const gv of genVerts) {
        for (const rv of refVerts) {
            const d = Math.sqrt((gv.x - rv.x) ** 2 + (gv.y - rv.y) ** 2 + (gv.z - rv.z) ** 2);
            if (d < 1.0) { matched1++; break; }
        }
    }
    console.log(`Matched <1mm: ${matched1}/${genVerts.length}`);

    const gs = vertexStats(genVerts);
    const rs = vertexStats(refVerts);
    if (genVerts.length > 0 && refVerts.length > 0) {
        const genRangeX = parseFloat(gs.x.max) - parseFloat(gs.x.min);
        const refRangeX = parseFloat(rs.x.max) - parseFloat(rs.x.min);
        const genRangeY = parseFloat(gs.y.max) - parseFloat(gs.y.min);
        const refRangeY = parseFloat(rs.y.max) - parseFloat(rs.y.min);
        const genRangeZ = parseFloat(gs.z.max) - parseFloat(gs.z.min);
        const refRangeZ = parseFloat(rs.z.max) - parseFloat(rs.z.min);
        console.log(`X range: gen=${genRangeX.toFixed(1)}, ref=${refRangeX.toFixed(1)}, ratio=${refRangeX > 0 ? (genRangeX/refRangeX).toFixed(3) : 'N/A'}`);
        console.log(`Y range: gen=${genRangeY.toFixed(1)}, ref=${refRangeY.toFixed(1)}, ratio=${refRangeY > 0 ? (genRangeY/refRangeY).toFixed(3) : 'N/A'}`);
        console.log(`Z range: gen=${genRangeZ.toFixed(1)}, ref=${refRangeZ.toFixed(1)}, ratio=${refRangeZ > 0 ? (genRangeZ/refRangeZ).toFixed(3) : 'N/A'}`);
    }
}
