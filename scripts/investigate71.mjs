#!/usr/bin/env node
/**
 * investigate71.mjs — Diagnose surface matching failures across all files
 * Clean-room analysis of public-domain NIST test files.
 *
 * For each file: show reference surface normals, find closest generated match,
 * and classify WHY surfaces don't match.
 */
import fs from 'node:fs';
import path from 'node:path';

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
function norm3(a) { return Math.sqrt(dot(a, a)); }

function extractSurfaces(entities) {
    const surfaces = [];
    for (const [id, e] of entities) {
        if (e.type === 'PLANE') {
            const axisRef = e.args.match(/#(\d+)/);
            if (!axisRef) continue;
            const ax = getAxis2(entities, parseInt(axisRef[1]));
            if (!ax || !ax.origin || !ax.normal) continue;
            const d = dot(ax.origin, ax.normal);
            surfaces.push({ id, type: 'plane', origin: ax.origin, normal: ax.normal, d });
        } else if (e.type === 'CYLINDRICAL_SURFACE') {
            const refs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
            const radiusMatch = e.args.match(/,\s*([\d.eE+-]+)\s*$/);
            const radius = radiusMatch ? parseFloat(radiusMatch[1]) : NaN;
            const ax = getAxis2(entities, refs[0]);
            if (!ax || !ax.origin || !ax.normal) continue;
            surfaces.push({ id, type: 'cylinder', origin: ax.origin, axis: ax.normal, radius });
        } else if (e.type === 'CONICAL_SURFACE') {
            const refs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
            // radius, semiAngle
            const nums = [...e.args.matchAll(/([\d.eE+-]+)/g)].map(m => parseFloat(m[1])).filter(x => !isNaN(x));
            const ax = getAxis2(entities, refs[0]);
            if (!ax || !ax.origin || !ax.normal) continue;
            // Last two numbers are radius and semiAngle
            const allNums = e.args.match(/,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*\)?\s*$/);
            const radius = allNums ? parseFloat(allNums[1]) : NaN;
            const semiAngle = allNums ? parseFloat(allNums[2]) : NaN;
            surfaces.push({ id, type: 'cone', origin: ax.origin, axis: ax.normal, radius, semiAngle });
        }
    }
    return surfaces;
}

// Analyze a single file pair
function analyzeFile(genPath, refPath, label) {
    if (!fs.existsSync(refPath) || !fs.existsSync(genPath)) return null;
    
    const genEntities = parseStepEntities(fs.readFileSync(genPath, 'utf-8'));
    const refEntities = parseStepEntities(fs.readFileSync(refPath, 'utf-8'));
    const genSurfs = extractSurfaces(genEntities);
    const refSurfs = extractSurfaces(refEntities);
    
    // Categorize reference surfaces
    const refByType = {};
    for (const s of refSurfs) {
        if (!refByType[s.type]) refByType[s.type] = [];
        refByType[s.type].push(s);
    }
    const genByType = {};
    for (const s of genSurfs) {
        if (!genByType[s.type]) genByType[s.type] = [];
        genByType[s.type].push(s);
    }
    
    // Analyze reference plane normals
    const refPlanes = refByType.plane || [];
    const genPlanes = genByType.plane || [];
    
    // Group reference planes by normal direction
    const normalGroups = [];
    for (const rp of refPlanes) {
        let found = false;
        for (const g of normalGroups) {
            if (Math.abs(dot(g.normal, rp.normal)) > 0.99) {
                g.planes.push(rp);
                found = true;
                break;
            }
        }
        if (!found) {
            normalGroups.push({ normal: rp.normal, planes: [rp] });
        }
    }
    
    // Check which normals we cover
    let coveredNormals = 0;
    let uncoveredNormals = 0;
    const uncoveredDetails = [];
    
    for (const g of normalGroups) {
        const n = g.normal;
        const isAxis = Math.abs(n[0]) > 0.99 || Math.abs(n[1]) > 0.99 || Math.abs(n[2]) > 0.99;
        
        // Check if ANY generated plane has this normal
        let hasCoverage = false;
        for (const gp of genPlanes) {
            if (Math.abs(dot(n, gp.normal)) > 0.98) {
                hasCoverage = true;
                break;
            }
        }
        
        if (hasCoverage) {
            coveredNormals++;
        } else {
            uncoveredNormals++;
            uncoveredDetails.push({
                normal: n,
                count: g.planes.length,
                isAxis,
                dValues: g.planes.map(p => p.d),
            });
        }
    }
    
    return {
        label,
        refCounts: {
            plane: refPlanes.length,
            cylinder: (refByType.cylinder || []).length,
            cone: (refByType.cone || []).length,
        },
        genCounts: {
            plane: genPlanes.length,
            cylinder: (genByType.cylinder || []).length,
            cone: (genByType.cone || []).length,
        },
        normalGroups: normalGroups.length,
        coveredNormals,
        uncoveredNormals,
        uncoveredDetails,
    };
}

// Process all files
const refDir = path.resolve('downloads/nist/NIST-FTC-CTC-PMI-CAD-models');
const outDir = path.resolve('output');
const files = [
    { gen: 'nist_ctc_01_asme1_rd_sw1802.stp', ref: 'CTC Definitions/nist_ctc_01_asme1_rd.stp', label: 'CTC_01' },
    { gen: 'nist_ctc_02_asme1_rc_sw1802.stp', ref: 'CTC Definitions/nist_ctc_02_asme1_rc.stp', label: 'CTC_02' },
    { gen: 'nist_ctc_03_asme1_rc_sw1802.stp', ref: 'CTC Definitions/nist_ctc_03_asme1_rc.stp', label: 'CTC_03' },
    { gen: 'nist_ctc_04_asme1_rd_sw1802.stp', ref: 'CTC Definitions/nist_ctc_04_asme1_rd.stp', label: 'CTC_04' },
    { gen: 'nist_ctc_05_asme1_rd_sw1802.stp', ref: 'CTC Definitions/nist_ctc_05_asme1_rd.stp', label: 'CTC_05' },
    { gen: 'nist_ftc_06_asme1_rd_sw1802.stp', ref: 'FTC Definitions/nist_ftc_06_asme1_rd.stp', label: 'FTC_06' },
    { gen: 'nist_ftc_07_asme1_rd_sw1802.stp', ref: 'FTC Definitions/nist_ftc_07_asme1_rd.stp', label: 'FTC_07' },
    { gen: 'nist_ftc_08_asme1_rc_sw1802.stp', ref: 'FTC Definitions/nist_ftc_08_asme1_rc.stp', label: 'FTC_08' },
    { gen: 'nist_ftc_09_asme1_rd_sw1802.stp', ref: 'FTC Definitions/nist_ftc_09_asme1_rd.stp', label: 'FTC_09' },
    { gen: 'nist_ftc_10_asme1_rb_sw1802.stp', ref: 'FTC Definitions/nist_ftc_10_asme1_rb.stp', label: 'FTC_10' },
    { gen: 'nist_ftc_11_asme1_rb_sw1802.stp', ref: 'FTC Definitions/nist_ftc_11_asme1_rb.stp', label: 'FTC_11' },
];

console.log('=== Surface Coverage Analysis ===\n');
console.log('File      Ref(p/c/cone) Gen(p/c/cone) NormalGroups Covered/Uncovered');
console.log('─'.repeat(85));

const allResults = [];
for (const f of files) {
    const result = analyzeFile(
        path.join(outDir, f.gen),
        path.join(refDir, f.ref),
        f.label,
    );
    if (!result) continue;
    allResults.push(result);
    
    const r = result.refCounts;
    const g = result.genCounts;
    console.log(
        `${result.label.padEnd(10)}` +
        `${String(r.plane).padStart(3)}/${String(r.cylinder).padStart(3)}/${String(r.cone).padStart(3)}  ` +
        `${String(g.plane).padStart(4)}/${String(g.cylinder).padStart(3)}/${String(g.cone).padStart(3)}  ` +
        `${String(result.normalGroups).padStart(6)} normals  ` +
        `${result.coveredNormals}/${result.normalGroups} covered`
    );
}

// Show uncovered normals for each file
console.log('\n=== Uncovered Normal Directions ===\n');
for (const result of allResults) {
    if (result.uncoveredDetails.length === 0) continue;
    console.log(`${result.label}:`);
    for (const u of result.uncoveredDetails) {
        const n = u.normal;
        console.log(`  n=[${n.map(v => v.toFixed(4))}] ${u.isAxis ? 'AXIS' : 'NON-AXIS'} — ${u.count} planes at d=${u.dValues.map(d => d.toFixed(2)).join(', ')}`);
    }
}

// Special deep-dive: FTC_11
console.log('\n=== FTC_11 Deep Dive ===');
const ftc11 = allResults.find(r => r.label === 'FTC_11');
if (ftc11) {
    console.log(`Reference: ${ftc11.refCounts.plane} planes, ${ftc11.refCounts.cylinder} cylinders`);
    console.log(`Generated: ${ftc11.genCounts.plane} planes, ${ftc11.genCounts.cylinder} cylinders`);
    console.log(`Normal groups: ${ftc11.normalGroups}, covered: ${ftc11.coveredNormals}, uncovered: ${ftc11.uncoveredNormals}`);
    
    // Detailed plane-by-plane comparison
    const genPath = path.join(outDir, 'nist_ftc_11_asme1_rb_sw1802.stp');
    const refPath2 = path.join(refDir, 'FTC Definitions/nist_ftc_11_asme1_rb.stp');
    const genEntities = parseStepEntities(fs.readFileSync(genPath, 'utf-8'));
    const refEntities = parseStepEntities(fs.readFileSync(refPath2, 'utf-8'));
    const genSurfs = extractSurfaces(genEntities);
    const refSurfs = extractSurfaces(refEntities);
    
    const genPlanes = genSurfs.filter(s => s.type === 'plane');
    const refPlanes = refSurfs.filter(s => s.type === 'plane');
    
    console.log('\nReference planes:');
    for (const rp of refPlanes) {
        const n = rp.normal;
        // Find closest generated plane
        let bestDot = 0, bestDDiff = Infinity, bestId = -1;
        for (const gp of genPlanes) {
            const d = Math.abs(dot(n, gp.normal));
            if (d > bestDot || (d > bestDot - 0.01 && Math.abs(rp.d - (dot(n, gp.normal) >= 0 ? 1 : -1) * gp.d) < bestDDiff)) {
                bestDot = d;
                const sign = dot(n, gp.normal) >= 0 ? 1 : -1;
                bestDDiff = Math.abs(rp.d - sign * gp.d);
                bestId = gp.id;
            }
        }
        const matched = bestDot > 0.98 && bestDDiff < 1.0;
        console.log(`  #${rp.id} n=[${n.map(v => v.toFixed(4))}] d=${rp.d.toFixed(3)} → ${matched ? '✓' : '✗'} bestGen#${bestId} dot=${bestDot.toFixed(4)} dDiff=${bestDDiff.toFixed(3)}`);
    }
    
    console.log('\nGenerated planes:');
    for (const gp of genPlanes) {
        console.log(`  #${gp.id} n=[${gp.normal.map(v => v.toFixed(4))}] d=${gp.d.toFixed(3)}`);
    }
}
