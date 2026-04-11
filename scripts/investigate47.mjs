/**
 * investigate47.mjs — Quick entity count check after adaptive clustering
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';

const step = fs.readFileSync('output/nist_ctc_01_asme1_rd_sw1802.stp', 'utf8');

const entities = ['PLANE', 'CYLINDRICAL_SURFACE', 'ADVANCED_FACE', 'FACE_OUTER_BOUND', 'FACE_BOUND', 'EDGE_LOOP', 'CLOSED_SHELL', 'MANIFOLD_SOLID_BREP', 'CIRCLE', 'LINE'];

for (const e of entities) {
    const re = new RegExp(`\\b${e}\\s*\\(`, 'g');
    const count = (step.match(re) || []).length;
    console.log(`${e}: ${count}`);
}

// Also check individual face data
const faceRe = /ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\(([^)]*)\)/g;
let match;
let facesWithInner = 0;
let totalInner = 0;
while ((match = faceRe.exec(step)) !== null) {
    const bounds = match[1].split(',').map(s => s.trim()).filter(s => s.startsWith('#'));
    // Check if any bound is FACE_BOUND (inner)
    let outerCount = 0, innerCount = 0;
    for (const ref of bounds) {
        const id = ref.replace('#', '');
        const refRe = new RegExp(`#${id}\\s*=\\s*(FACE_OUTER_BOUND|FACE_BOUND)`);
        const m = step.match(refRe);
        if (m && m[1] === 'FACE_BOUND') innerCount++;
        if (m && m[1] === 'FACE_OUTER_BOUND') outerCount++;
    }
    if (innerCount > 0) {
        facesWithInner++;
        totalInner += innerCount;
    }
}
console.log(`\nFaces with inner loops: ${facesWithInner}`);
console.log(`Total inner loop bounds: ${totalInner}`);
