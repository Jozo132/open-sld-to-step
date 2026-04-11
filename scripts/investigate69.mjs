#!/usr/bin/env node
/**
 * investigate69.mjs — Find what reference cylinders we're missing for CTC_01.
 * Compare generated vs reference cylinder axes, origins, and radii.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';

// Parse CYLINDRICAL_SURFACE from STEP
function parseCylinders(text) {
    const cyls = [];
    const re = /CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([\d.eE+-]+)\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const axId = m[1];
        const radius = parseFloat(m[2]);
        
        const axRe = new RegExp(`#${axId}\\s*=\\s*AXIS2_PLACEMENT_3D\\s*\\(\\s*'[^']*'\\s*,\\s*#(\\d+)\\s*,\\s*#(\\d+)`);
        const am = text.match(axRe);
        if (!am) continue;
        
        const ptRe = new RegExp(`#${am[1]}\\s*=\\s*CARTESIAN_POINT\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
        const dirRe = new RegExp(`#${am[2]}\\s*=\\s*DIRECTION\\s*\\(\\s*'[^']*'\\s*,\\s*\\(([^)]+)\\)`);
        const pm = text.match(ptRe);
        const dm = text.match(dirRe);
        if (!pm || !dm) continue;
        
        const origin = pm[1].split(',').map(Number);
        const axis = dm[1].split(',').map(Number);
        cyls.push({ origin, axis, radius });
    }
    return cyls;
}

const genText = fs.readFileSync('output/nist_ctc_01_asme1_rd_sw1802.stp', 'utf8');
const refText = fs.readFileSync('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_01_asme1_rd.stp', 'utf8');

const genCyls = parseCylinders(genText);
const refCyls = parseCylinders(refText);

console.log(`Generated cylinders: ${genCyls.length}`);
console.log(`Reference cylinders: ${refCyls.length}`);

// Match generated to reference
function cylDist(g, r) {
    const dot = g.axis[0]*r.axis[0] + g.axis[1]*r.axis[1] + g.axis[2]*r.axis[2];
    if (Math.abs(Math.abs(dot) - 1) > 0.01) return Infinity;
    if (Math.abs(g.radius - r.radius) > 0.5) return Infinity;
    // Perpendicular distance between axis lines
    const dx = g.origin[0] - r.origin[0];
    const dy = g.origin[1] - r.origin[1];
    const dz = g.origin[2] - r.origin[2];
    const along = dx*r.axis[0] + dy*r.axis[1] + dz*r.axis[2];
    const px = dx - along*r.axis[0], py = dy - along*r.axis[1], pz = dz - along*r.axis[2];
    return Math.sqrt(px*px + py*py + pz*pz);
}

const matched = new Set();
for (const g of genCyls) {
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < refCyls.length; i++) {
        if (matched.has(i)) continue;
        const d = cylDist(g, refCyls[i]);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestDist < 5.0 && bestIdx >= 0) matched.add(bestIdx);
}

console.log(`\nMatched: ${matched.size}`);
console.log(`\n=== Unmatched reference cylinders (${refCyls.length - matched.size}) ===`);
for (let i = 0; i < refCyls.length; i++) {
    if (matched.has(i)) continue;
    const r = refCyls[i];
    console.log(`  axis=(${r.axis.map(v=>v.toFixed(3)).join(',')}) r=${r.radius.toFixed(3)} origin=(${r.origin.map(v=>v.toFixed(1)).join(',')})`);
}

// Group by radius
const unmatchedByRadius = {};
for (let i = 0; i < refCyls.length; i++) {
    if (matched.has(i)) continue;
    const r = refCyls[i].radius.toFixed(1);
    if (!unmatchedByRadius[r]) unmatchedByRadius[r] = 0;
    unmatchedByRadius[r]++;
}
console.log('\nUnmatched by radius:');
for (const [r, count] of Object.entries(unmatchedByRadius).sort((a,b)=>Number(a[0])-Number(b[0]))) {
    console.log(`  r=${r}mm: ${count}`);
}

// Show ref cylinder radius distribution
const refByRadius = {};
for (const r of refCyls) {
    const k = r.radius.toFixed(1);
    if (!refByRadius[k]) refByRadius[k] = 0;
    refByRadius[k]++;
}
console.log('\nAll reference cylinders by radius:');
for (const [r, count] of Object.entries(refByRadius).sort((a,b)=>Number(a[0])-Number(b[0]))) {
    const mCount = genCyls.filter(g => Math.abs(g.radius - Number(r)) < 0.5).length;
    console.log(`  r=${r}mm: ${count} ref, ${mCount} gen`);
}
