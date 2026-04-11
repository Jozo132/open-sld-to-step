#!/usr/bin/env node
/**
 * investigate60.mjs — Quick entity count comparison before/after changes
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'fs';

const step = fs.readFileSync('output/nist_ctc_01_asme1_rd_sw1802.stp', 'utf8');
const entities = ['PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'ADVANCED_FACE', 'FACE_OUTER_BOUND', 'FACE_BOUND', 'EDGE_LOOP', 'CIRCLE', 'LINE'];
for (const e of entities) {
    const re = new RegExp(`\\b${e}\\s*\\(`, 'g');
    console.log(`${e}: ${(step.match(re) || []).length}`);
}

// Also count per-file: planes generated
const files = fs.readdirSync('output').filter(f => f.endsWith('.stp'));
console.log('\n=== Per-file plane and face counts ===');
for (const f of files.sort()) {
    const s = fs.readFileSync(`output/${f}`, 'utf8');
    const planes = (s.match(/\bPLANE\s*\(/g) || []).length;
    const cyls = (s.match(/\bCYLINDRICAL_SURFACE\s*\(/g) || []).length;
    const faces = (s.match(/\bADVANCED_FACE\s*\(/g) || []).length;
    const innerBounds = (s.match(/\bFACE_BOUND\s*\(/g) || []).length;
    const name = f.replace('nist_', '').replace('_sw1802.stp', '');
    console.log(`  ${name.padEnd(25)} planes=${String(planes).padStart(3)}  cyls=${String(cyls).padStart(3)}  faces=${String(faces).padStart(3)}  inner=${String(innerBounds).padStart(3)}`);
}
