/**
 * investigate41.mjs — Verify the new bounded STEP output vs reference
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Read our output
const ourPath = path.join(ROOT, 'output', 'nist_ctc_01_asme1_rd_sw1802.stp');
const ourContent = fs.readFileSync(ourPath, 'utf-8');

// Read reference
const refPath = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions', 'nist_ctc_01_asme1_rd.stp');
const refContent = fs.readFileSync(refPath, 'utf-8');

function countEntities(content) {
    const lines = content.split('\n');
    const entities = {};
    // Join continuation lines
    const fullEntities = [];
    let current = '';
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) {
            if (current) fullEntities.push(current);
            current = trimmed;
        } else if (current && trimmed.endsWith(';')) {
            current += ' ' + trimmed;
            fullEntities.push(current);
            current = '';
        } else if (current) {
            current += ' ' + trimmed;
        }
    }
    if (current) fullEntities.push(current);

    for (const ent of fullEntities) {
        const m = ent.match(/^#\d+=\s*(\w+)\s*\(/);
        if (m) {
            const type = m[1];
            entities[type] = (entities[type] || 0) + 1;
        }
    }
    return entities;
}

const ourEntities = countEntities(ourContent);
const refEntities = countEntities(refContent);

const interesting = [
    'PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE',
    'LINE', 'CIRCLE', 'VECTOR',
    'EDGE_CURVE', 'ORIENTED_EDGE', 'EDGE_LOOP',
    'FACE_BOUND', 'FACE_OUTER_BOUND', 'ADVANCED_FACE',
    'CLOSED_SHELL', 'OPEN_SHELL', 'MANIFOLD_SOLID_BREP',
    'CARTESIAN_POINT', 'DIRECTION', 'AXIS2_PLACEMENT_3D',
    'VERTEX_POINT', 'B_SPLINE_CURVE_WITH_KNOTS',
    'ADVANCED_BREP_SHAPE_REPRESENTATION', 'SHAPE_REPRESENTATION',
];

console.log('Entity type comparison (Ours vs Reference):');
console.log('─'.repeat(60));
console.log(`${'Entity Type'.padEnd(40)} ${'Ours'.padStart(6)} ${'Ref'.padStart(6)}`);
console.log('─'.repeat(60));
for (const type of interesting) {
    const ours = ourEntities[type] || 0;
    const ref = refEntities[type] || 0;
    if (ours > 0 || ref > 0) {
        const diff = ours === ref ? '  ✓' : ours > ref ? ` +${ours - ref}` : ` -${ref - ours}`;
        console.log(`${type.padEnd(40)} ${String(ours).padStart(6)} ${String(ref).padStart(6)} ${diff}`);
    }
}

// Check if output has proper structure
console.log('\n=== Structure checks ===');
console.log(`Has ISO header: ${ourContent.includes('ISO-10303-21;')}`);
console.log(`Has END marker: ${ourContent.includes('END-ISO-10303-21;')}`);
console.log(`Has CLOSED_SHELL: ${ourContent.includes('CLOSED_SHELL')}`);
console.log(`Has OPEN_SHELL: ${ourContent.includes('OPEN_SHELL')}`);
console.log(`Has MANIFOLD_SOLID_BREP: ${ourContent.includes('MANIFOLD_SOLID_BREP')}`);
console.log(`Has ADVANCED_BREP: ${ourContent.includes('ADVANCED_BREP_SHAPE_REPRESENTATION')}`);

// Show first few edge loops to check they have actual edges
const edgeLoopMatches = ourContent.match(/#\d+=EDGE_LOOP\([^)]*\)/g) || [];
console.log(`\nSample edge loops (first 5):`);
for (const el of edgeLoopMatches.slice(0, 5)) {
    console.log(`  ${el}`);
}

// Show a sample face
const faceMatches = ourContent.match(/#\d+=ADVANCED_FACE\([^)]*\)/g) || [];
console.log(`\nSample faces (first 3):`);
for (const f of faceMatches.slice(0, 3)) {
    console.log(`  ${f}`);
}

// Count empty vs non-empty edge loops
let emptyLoops = 0, nonEmptyLoops = 0;
for (const el of edgeLoopMatches) {
    if (el.includes('()')) emptyLoops++;
    else nonEmptyLoops++;
}
console.log(`\nEdge loops: ${nonEmptyLoops} non-empty, ${emptyLoops} empty`);
