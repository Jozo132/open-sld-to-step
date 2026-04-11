#!/usr/bin/env node
/**
 * investigate68.mjs — Analyze face matching gaps and identify highest-impact
 * improvements across all files. Focus on what moves the weighted score.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';

// Parse a STEP file to count entity types
function countStepEntities(text) {
    const counts = {};
    const typeRe = /=\s*(PLANE|CYLINDRICAL_SURFACE|CONICAL_SURFACE|SPHERICAL_SURFACE|TOROIDAL_SURFACE|B_SPLINE_SURFACE_WITH_KNOTS|ADVANCED_FACE|FACE_OUTER_BOUND|FACE_BOUND|EDGE_LOOP|CLOSED_SHELL|MANIFOLD_SOLID_BREP|CIRCLE|CARTESIAN_POINT|DIRECTION|VERTEX_POINT)\s*\(/gi;
    let m;
    while ((m = typeRe.exec(text)) !== null) {
        const type = m[1].toUpperCase();
        counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
}

// Count just reference surface types per file
const refDir = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const genDir = 'output';

const pairs = [
    ['nist_ctc_01_asme1_rd_sw1802.stp', 'CTC Definitions/nist_ctc_01_asme1_rd.stp'],
    ['nist_ctc_02_asme1_rc_sw1802.stp', 'CTC Definitions/nist_ctc_02_asme1_rc.stp'],
    ['nist_ctc_03_asme1_rc_sw1802.stp', 'CTC Definitions/nist_ctc_03_asme1_rc.stp'],
    ['nist_ctc_04_asme1_rd_sw1802.stp', 'CTC Definitions/nist_ctc_04_asme1_rd.stp'],
    ['nist_ctc_05_asme1_rd_sw1802.stp', 'CTC Definitions/nist_ctc_05_asme1_rd.stp'],
    ['nist_ftc_06_asme1_rd_sw1802.stp', 'FTC Definitions/nist_ftc_06_asme1_rd.stp'],
    ['nist_ftc_07_asme1_rd_sw1802.stp', 'FTC Definitions/nist_ftc_07_asme1_rd.stp'],
    ['nist_ftc_08_asme1_rc_sw1802.stp', 'FTC Definitions/nist_ftc_08_asme1_rc.stp'],
    ['nist_ftc_09_asme1_rd_sw1802.stp', 'FTC Definitions/nist_ftc_09_asme1_rd.stp'],
    ['nist_ftc_10_asme1_rb_sw1802.stp', 'FTC Definitions/nist_ftc_10_asme1_rb.stp'],
    ['nist_ftc_11_asme1_rb_sw1802.stp', 'FTC Definitions/nist_ftc_11_asme1_rb.stp'],
];

console.log('=== Reference surface type breakdown ===');
console.log('File                        PLANE  CYL    CONE   SPHERE TORUS  BSPLINE  FACE');
console.log('─'.repeat(90));

let totalRefCones = 0, totalRefTori = 0, totalRefSpheres = 0, totalRefBspline = 0;
let totalRefFaces = 0, totalGenFaces = 0;

for (const [genFile, refFile] of pairs) {
    const refText = fs.readFileSync(path.join(refDir, refFile), 'utf8');
    const genText = fs.readFileSync(path.join(genDir, genFile), 'utf8');
    const ref = countStepEntities(refText);
    const gen = countStepEntities(genText);
    
    const name = genFile.replace('_sw1802.stp', '').replace('nist_', '');
    const rP = ref.PLANE || 0;
    const rC = ref.CYLINDRICAL_SURFACE || 0;
    const rK = ref.CONICAL_SURFACE || 0;
    const rS = ref.SPHERICAL_SURFACE || 0;
    const rT = ref.TOROIDAL_SURFACE || 0;
    const rB = ref.B_SPLINE_SURFACE_WITH_KNOTS || 0;
    const rF = ref.ADVANCED_FACE || 0;
    const gF = gen.ADVANCED_FACE || 0;
    const gP = gen.PLANE || 0;
    const gC = gen.CYLINDRICAL_SURFACE || 0;
    const gK = gen.CONICAL_SURFACE || 0;
    
    totalRefCones += rK;
    totalRefTori += rT;
    totalRefSpheres += rS;
    totalRefBspline += rB;
    totalRefFaces += rF;
    totalGenFaces += gF;
    
    console.log(`${name.padEnd(28)} ${String(rP).padStart(5)}  ${String(rC).padStart(5)}  ${String(rK).padStart(5)}  ${String(rS).padStart(6)}  ${String(rT).padStart(5)}  ${String(rB).padStart(7)}  ${String(rF).padStart(4)} ref / ${String(gF).padStart(4)} gen (p=${gP} c=${gC} k=${gK})`);
}

console.log('\n=== Surface types we CANNOT generate ===');
console.log(`Total reference CONICAL_SURFACE: ${totalRefCones}`);
console.log(`Total reference TOROIDAL_SURFACE: ${totalRefTori}`);
console.log(`Total reference SPHERICAL_SURFACE: ${totalRefSpheres}`);
console.log(`Total reference B_SPLINE_SURFACE: ${totalRefBspline}`);
console.log(`\nThese reference faces can NEVER be matched → ceiling on face score.`);

// Calculate theoretical ceiling if we matched all planes + cylinders perfectly
console.log('\n=== Theoretical face matching ceiling ===');
for (const [genFile, refFile] of pairs) {
    const refText = fs.readFileSync(path.join(refDir, refFile), 'utf8');
    const ref = countStepEntities(refText);
    const rP = ref.PLANE || 0;
    const rC = ref.CYLINDRICAL_SURFACE || 0;
    const rK = ref.CONICAL_SURFACE || 0;
    const rS = ref.SPHERICAL_SURFACE || 0;
    const rT = ref.TOROIDAL_SURFACE || 0;
    const rB = ref.B_SPLINE_SURFACE_WITH_KNOTS || 0;
    const rF = ref.ADVANCED_FACE || 0;
    // Each surface can produce ~1 face. Planes can produce multiple faces.
    // But approximately: matchable faces ≤ plane faces + cylinder faces
    // Reference faces on unmatchable surfaces = faces on cones + tori + spheres + bsplines
    // Rough estimate: faces proportional to surface count
    const matchableSurfs = rP + rC;
    const totalSurfs = rP + rC + rK + rS + rT + rB;
    const estMatchableFaces = totalSurfs > 0 ? Math.round(rF * matchableSurfs / totalSurfs) : rF;
    const ceiling = rF > 0 ? (estMatchableFaces / rF * 100).toFixed(1) : '100.0';
    
    const name = genFile.replace('_sw1802.stp', '').replace('nist_', '');
    console.log(`  ${name}: ${ceiling}% ceiling (${estMatchableFaces}/${rF} matchable faces, ${rK} cones + ${rT} tori + ${rS} spheres)`);
}
