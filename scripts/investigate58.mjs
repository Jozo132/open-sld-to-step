#!/usr/bin/env node
/**
 * investigate58.mjs — Analyze unmatched planes between generated and reference STEP files
 * Clean-room analysis of public-domain NIST test files.
 * NIST test files are US Government works (public domain).
 */
import fs from 'fs';

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
        const sm = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (sm) entities.set(id, { type: sm[1], types: [sm[1]], args: sm[2] });
    }
    return entities;
}

function resolveCartesianPoint(entities, id) {
    const e = entities.get(id);
    if (!e || !e.types.includes('CARTESIAN_POINT')) return null;
    const m = e.args.match(/\(\s*([^)]+)\s*\)/);
    return m ? m[1].split(',').map(s => parseFloat(s.trim())) : null;
}

function resolveDirection(entities, id) {
    const e = entities.get(id);
    if (!e || !e.types.includes('DIRECTION')) return null;
    const m = e.args.match(/\(\s*([^)]+)\s*\)/);
    if (!m) return null;
    const v = m[1].split(',').map(s => parseFloat(s.trim()));
    const len = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
    return len > 1e-15 ? [v[0]/len, v[1]/len, v[2]/len] : v;
}

function resolveAxis2Placement(entities, id) {
    const e = entities.get(id);
    if (!e || !e.types.includes('AXIS2_PLACEMENT_3D')) return null;
    const refs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
    return {
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0]) : null,
        axis: refs[1] ? resolveDirection(entities, refs[1]) : null,
    };
}

function extractPlanes(entities) {
    const planes = [];
    for (const [id, e] of entities) {
        if (!e.types.includes('PLANE')) continue;
        const axRef = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10))[0];
        const ax = axRef ? resolveAxis2Placement(entities, axRef) : null;
        if (ax?.origin && ax?.axis) {
            const n = ax.axis, o = ax.origin;
            const d = n[0]*o[0] + n[1]*o[1] + n[2]*o[2];
            planes.push({ id, origin: o, normal: n, d });
        }
    }
    return planes;
}

function detectScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1.0;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000.0;
    return 1.0;
}

function scalePlanes(planes, factor) {
    return planes.map(p => ({
        ...p,
        origin: p.origin.map(v => v * factor),
        d: p.d * factor,
    }));
}

const genText = fs.readFileSync('output/nist_ctc_01_asme1_rd_sw1802.stp', 'utf8');
const refText = fs.readFileSync('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_01_asme1_rd.stp', 'utf8');

const genE = parseStepEntities(genText);
const refE = parseStepEntities(refText);

let genPlanes = extractPlanes(genE);
let refPlanes = extractPlanes(refE);

const gs = detectScale(genText);
const rs = detectScale(refText);
if (gs !== 1.0) genPlanes = scalePlanes(genPlanes, gs);
if (rs !== 1.0) refPlanes = scalePlanes(refPlanes, rs);

console.log(`Generated planes: ${genPlanes.length}, Reference planes: ${refPlanes.length}`);

// Try to match each generated plane to a reference plane
const usedRef = new Set();
const matched = [];
const unmatchedGen = [];

for (const gp of genPlanes) {
    let bestDist = Infinity, bestRef = null;
    for (let ri = 0; ri < refPlanes.length; ri++) {
        if (usedRef.has(ri)) continue;
        const rp = refPlanes[ri];
        const dot = gp.normal[0]*rp.normal[0]+gp.normal[1]*rp.normal[1]+gp.normal[2]*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.02) continue;
        const rd = dot > 0 ? rp.d : -rp.d;
        const dist = Math.abs(gp.d - rd);
        if (dist < bestDist) { bestDist = dist; bestRef = ri; }
    }
    if (bestRef !== null && bestDist <= 1.0) {
        usedRef.add(bestRef);
        matched.push({ gen: gp, ref: refPlanes[bestRef], dist: bestDist });
    } else {
        unmatchedGen.push({ plane: gp, bestDist });
    }
}

const unmatchedRef = refPlanes.filter((_, i) => !usedRef.has(i));

console.log(`\nMatched: ${matched.length}`);
console.log(`\nUnmatched generated planes (${unmatchedGen.length}):`);
for (const { plane: p, bestDist } of unmatchedGen.slice(0, 20)) {
    const n = p.normal.map(v => v.toFixed(3)).join(',');
    console.log(`  n=(${n}) d=${p.d.toFixed(2)} origin=(${p.origin.map(v=>v.toFixed(1)).join(',')}) bestDist=${bestDist.toFixed(3)}`);
}

console.log(`\nUnmatched reference planes (${unmatchedRef.length}):`);
for (const p of unmatchedRef.slice(0, 20)) {
    const n = p.normal.map(v => v.toFixed(3)).join(',');
    console.log(`  #${p.id}: n=(${n}) d=${p.d.toFixed(2)} origin=(${p.origin.map(v=>v.toFixed(1)).join(',')})`)
}

// Find near-misses: unmatched gen planes that are close to unmatched ref planes
console.log(`\nNear-misses (unmatched gen ↔ unmatched ref, d diff 1-5mm):`);
for (const { plane: gp } of unmatchedGen) {
    for (const rp of unmatchedRef) {
        const dot = gp.normal[0]*rp.normal[0]+gp.normal[1]*rp.normal[1]+gp.normal[2]*rp.normal[2];
        if (Math.abs(Math.abs(dot)-1) > 0.05) continue;
        const rd = dot > 0 ? rp.d : -rp.d;
        const dist = Math.abs(gp.d - rd);
        if (dist > 1.0 && dist < 5.0) {
            console.log(`  gen: n=(${gp.normal.map(v=>v.toFixed(3)).join(',')}) d=${gp.d.toFixed(2)}  ref: n=(${rp.normal.map(v=>v.toFixed(3)).join(',')}) d=${rp.d.toFixed(2)}  diff=${dist.toFixed(3)}mm`);
        }
    }
}
