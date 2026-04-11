#!/usr/bin/env node
/**
 * investigate72.mjs — Trace which planes are from extraction vs inference for CTC_01
 * Clean-room analysis of public-domain NIST test files.
 *
 * Compares our generated STEP against the reference to identify:
 * - Which generated planes MATCH the reference
 * - Which generated planes are WRONG (don't match any reference)
 * - Whether wrong planes come from extraction or inference
 */
import fs from 'node:fs';
import path from 'node:path';

// Import the parser to get extraction vs inference breakdown
// Run against the converted STEP file
const genPath = path.resolve('output/nist_ctc_01_asme1_rd_sw1802.stp');
const refPath = path.resolve('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_01_asme1_rd.stp');

function parseStepEntities(text) {
    const entities = new Map();
    const dataSection = text.replace(/\r\n/g, '\n');
    const dataStart = dataSection.indexOf('DATA;');
    const dataEnd = dataSection.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;
    const data = dataSection.slice(dataStart + 5, dataEnd);
    const joined = data.replace(/\n(?!#\d+=)/g, '');
    const reLine = /^#(\d+)\s*=\s*(.+);$/gm;
    let m;
    while ((m = reLine.exec(joined)) !== null) {
        const id = parseInt(m[1], 10);
        const rest = m[2].trim();
        const typeMatch = rest.match(/^(\w+)\s*\((.+)\)$/s);
        if (typeMatch) {
            entities.set(id, { type: typeMatch[1], args: typeMatch[2] });
        }
    }
    return entities;
}

function parseFloatList(s) {
    return s.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));
}

function extractDirection(entities, id) {
    const e = entities.get(id);
    if (!e || e.type !== 'DIRECTION') return null;
    const coordMatch = e.args.match(/\(([^)]+)\)/);
    if (!coordMatch) return null;
    return parseFloatList(coordMatch[1]);
}

function extractPoint(entities, id) {
    const e = entities.get(id);
    if (!e || e.type !== 'CARTESIAN_POINT') return null;
    const coordMatch = e.args.match(/\(([^)]+)\)/);
    if (!coordMatch) return null;
    return parseFloatList(coordMatch[1]);
}

function getAxis2(entities, id) {
    const e = entities.get(id);
    if (!e || e.type !== 'AXIS2_PLACEMENT_3D') return null;
    const refs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
    const origin = extractPoint(entities, refs[0]);
    const normal = refs[1] ? extractDirection(entities, refs[1]) : null;
    return { origin, normal };
}

function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

function extractPlanes(entities) {
    const planes = [];
    for (const [id, e] of entities) {
        if (e.type !== 'PLANE') continue;
        const axisRef = e.args.match(/#(\d+)/);
        if (!axisRef) continue;
        const ax = getAxis2(entities, parseInt(axisRef[1]));
        if (!ax || !ax.origin || !ax.normal) continue;
        const d = dot(ax.origin, ax.normal);
        planes.push({ id, origin: ax.origin, normal: ax.normal, d });
    }
    return planes;
}

// Parse both files
const genEntities = parseStepEntities(fs.readFileSync(genPath, 'utf-8'));
const refEntities = parseStepEntities(fs.readFileSync(refPath, 'utf-8'));
const genPlanes = extractPlanes(genEntities);
const refPlanes = extractPlanes(refEntities);

// Match generated to reference (greedy)
const refMatched = new Set();
const genResults = [];

for (const gp of genPlanes) {
    let bestDist = Infinity;
    let bestRefId = -1;
    
    for (const rp of refPlanes) {
        if (refMatched.has(rp.id)) continue;
        const dotN = dot(gp.normal, rp.normal);
        if (Math.abs(Math.abs(dotN) - 1.0) > 0.02) continue;
        const sign = dotN > 0 ? 1 : -1;
        const dDiff = Math.abs(gp.d - sign * rp.d);
        if (dDiff < bestDist) {
            bestDist = dDiff;
            bestRefId = rp.id;
        }
    }
    
    const matched = bestDist <= 1.0;
    if (matched && bestRefId >= 0) refMatched.add(bestRefId);
    
    // Classify: is the normal axis-aligned?
    const isAxis = Math.abs(gp.normal[0]) > 0.99 || Math.abs(gp.normal[1]) > 0.99 || Math.abs(gp.normal[2]) > 0.99;
    
    genResults.push({
        id: gp.id,
        normal: gp.normal,
        d: gp.d,
        matched,
        bestDist: bestDist === Infinity ? 'INF' : bestDist.toFixed(3),
        bestRefId,
        isAxis,
    });
}

// Summary
const matchedResults = genResults.filter(r => r.matched);
const wrongResults = genResults.filter(r => !r.matched);
const wrongAxis = wrongResults.filter(r => r.isAxis);
const wrongNonAxis = wrongResults.filter(r => !r.isAxis);

console.log(`\n=== CTC_01 Plane Match Analysis ===`);
console.log(`Generated: ${genPlanes.length} planes`);
console.log(`Reference: ${refPlanes.length} planes`);
console.log(`Matched: ${matchedResults.length} / ${genPlanes.length}`);
console.log(`Wrong: ${wrongResults.length} (${wrongAxis.length} axis-aligned, ${wrongNonAxis.length} non-axis)`);
console.log(`Unmatched ref: ${refPlanes.length - refMatched.size}`);

// Group wrong planes by normal
console.log(`\n--- Wrong Axis Planes ---`);
for (const r of wrongAxis) {
    console.log(`  #${r.id}: n=[${r.normal.map(v => v.toFixed(4))}] d=${r.d.toFixed(3)} bestDist=${r.bestDist}`);
}

console.log(`\n--- Wrong Non-Axis Planes ---`);
for (const r of wrongNonAxis) {
    console.log(`  #${r.id}: n=[${r.normal.map(v => v.toFixed(4))}] d=${r.d.toFixed(3)} bestDist=${r.bestDist}`);
}

// Group matched planes by d-distance
console.log(`\n--- Match Quality Distribution ---`);
const buckets = [0.1, 0.2, 0.5, 1.0];
for (const b of buckets) {
    const count = matchedResults.filter(r => parseFloat(r.bestDist) <= b).length;
    console.log(`  d ≤ ${b}mm: ${count} planes`);
}

// Unmatched reference planes
console.log(`\n--- Unmatched Reference Planes ---`);
for (const rp of refPlanes) {
    if (!refMatched.has(rp.id)) {
        const isAxis = Math.abs(rp.normal[0]) > 0.99 || Math.abs(rp.normal[1]) > 0.99 || Math.abs(rp.normal[2]) > 0.99;
        console.log(`  Ref#${rp.id}: n=[${rp.normal.map(v => v.toFixed(4))}] d=${rp.d.toFixed(3)} ${isAxis ? 'AXIS' : 'NON-AXIS'}`);
    }
}
