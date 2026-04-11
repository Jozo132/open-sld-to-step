/**
 * investigate31.mjs
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal: Validate surface/face/edge extraction from sentinel blocks.
 * 1. Parse PS binary using sentinel + sub-record separator approach
 * 2. Extract plane/cylinder geometry from type-0x1E entities
 * 3. Extract face references from type-0x0F entities
 * 4. Cross-check against STEP reference file
 * 5. Determine what topology we can reliably reconstruct
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');
const ctcDefDir = join(stpDir, 'CTC Definitions');
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

// ── Load Parasolid from SLDPRT ──────────────────────────────────────────────

function getLargestPS(filePath) {
    const buf = readFileSync(filePath);
    let best = null, idx = 0;
    while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const cs = buf.readUInt32LE(idx + 14), ds = buf.readUInt32LE(idx + 18), nl = buf.readUInt32LE(idx + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50_000_000) {
            const po = idx + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try { const n = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 }); if (n.length >= 20 && n[0] === 0x50 && n[1] === 0x53 && (!best || n.length > best.length)) best = n; } catch {}
                    }
                    if (dec.length >= 20 && dec[0] === 0x50 && dec[1] === 0x53 && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

// ── Parse entities from sentinel blocks ─────────────────────────────────────

function parseEntities(ps) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx++; }

    const entities = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + 6;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        // Find sub-record starts
        const subStarts = [0];
        let searchFrom = 0;
        while (searchFrom < block.length - 6) {
            const sepIdx = block.indexOf(SUB_SEP, searchFrom);
            if (sepIdx < 0) break;
            subStarts.push(sepIdx + 6);
            searchFrom = sepIdx + 6;
        }

        for (let si = 0; si < subStarts.length; si++) {
            const recStart = subStarts[si];
            const recEnd = (si + 1 < subStarts.length) ? subStarts[si + 1] - 6 : block.length;
            if (recStart + 4 > block.length) continue;
            const rec = block.subarray(recStart, recEnd);

            let type = -1, id = -1, dataOff = -1;

            if (si === 0 && rec.length >= 8 && rec.readUInt32BE(0) === 3) {
                type = rec.readUInt16BE(4);
                id = rec.readUInt16BE(6);
                dataOff = 8;
            } else if (rec.length >= 4 && rec[0] === 0x00 && rec[1] >= 0x0d && rec[1] <= 0x85) {
                type = rec.readUInt16BE(0);
                id = rec.readUInt16BE(2);
                dataOff = 4;
            }

            if (type < 0 || id < 0 || dataOff < 0) continue;
            entities.push({ type, id, data: rec.subarray(dataOff), fullRec: rec });
        }
    }
    return entities;
}

// ── Surface/curve geometry extraction ───────────────────────────────────────

function classifySurface(entity) {
    const d = entity.data;
    // Find 0x2B marker that precedes float data
    for (let j = 0; j < d.length - 9; j++) {
        if (d[j] === 0x2b) {
            const testVal = d.readDoubleBE(j + 1);
            if (!isFinite(testVal) || Math.abs(testVal) > 1e6) continue;
            // Count consecutive valid floats
            const floats = [];
            for (let k = j + 1; k + 8 <= d.length; k += 8) {
                const v = d.readDoubleBE(k);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                floats.push(v);
            }
            if (floats.length < 4) continue;

            if (floats.length === 7) {
                const normMag = Math.sqrt(floats[3]**2 + floats[4]**2 + floats[5]**2);
                if (Math.abs(normMag - 1) < 0.01 && Math.abs(floats[6]) < 0.01) {
                    return { surfaceType: 'plane', origin: { x: floats[0], y: floats[1], z: floats[2] }, normal: { x: floats[3], y: floats[4], z: floats[5] }, floats };
                }
            }
            if (floats.length === 8) {
                const axisMag = Math.sqrt(floats[3]**2 + floats[4]**2 + floats[5]**2);
                if (Math.abs(axisMag - 1) < 0.01) {
                    return { surfaceType: 'cylinder', origin: { x: floats[0], y: floats[1], z: floats[2] }, axis: { x: floats[3], y: floats[4], z: floats[5] }, radius: floats[7], floats };
                }
            }
            if (floats.length >= 10) {
                const axisMag = Math.sqrt(floats[3]**2 + floats[4]**2 + floats[5]**2);
                if (Math.abs(axisMag - 1) < 0.01) {
                    return { surfaceType: 'cylinder_ext', origin: { x: floats[0], y: floats[1], z: floats[2] }, axis: { x: floats[3], y: floats[4], z: floats[5] }, floats };
                }
            }
            return { surfaceType: 'unknown', floatCount: floats.length, floats };
        }
    }
    return null;
}

// ── Point extraction ────────────────────────────────────────────────────────

function extractPoint(entity) {
    const d = entity.data;
    if (d.length < 12 + 24) return null;
    if (d[0] !== 0x00 || d[1] !== 0x00) return null;
    if (d[4] !== 0x00 || d[5] !== 0x01) return null;
    const x = d.readDoubleBE(12);
    const y = d.readDoubleBE(20);
    const z = d.readDoubleBE(28);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) return null;
    return { x, y, z };
}

// ── Parse STEP reference ────────────────────────────────────────────────────

function parseStepSurfaces(path) {
    const text = readFileSync(path, 'utf-8');

    const cartesianPoints = new Map();
    for (const m of text.matchAll(/#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*\)/g)) {
        cartesianPoints.set(parseInt(m[1]), m[2].split(',').map(s => parseFloat(s.trim())));
    }
    const directions = new Map();
    for (const m of text.matchAll(/#(\d+)\s*=\s*DIRECTION\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*\)/g)) {
        directions.set(parseInt(m[1]), m[2].split(',').map(s => parseFloat(s.trim())));
    }
    const axis2placements = new Map();
    for (const m of text.matchAll(/#(\d+)\s*=\s*AXIS2_PLACEMENT_3D\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*#(\d+)\s*,\s*#(\d+)\s*\)/g)) {
        axis2placements.set(parseInt(m[1]), { loc: parseInt(m[2]), z: parseInt(m[3]), x: parseInt(m[4]) });
    }

    const planes = [];
    for (const m of text.matchAll(/#(\d+)\s*=\s*PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g)) {
        const axis = axis2placements.get(parseInt(m[2]));
        if (!axis) continue;
        const origin = cartesianPoints.get(axis.loc);
        const normal = directions.get(axis.z);
        if (origin && normal) planes.push({ id: parseInt(m[1]), origin, normal });
    }

    const cylinders = [];
    for (const m of text.matchAll(/#(\d+)\s*=\s*CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([-\d.eE+]+)\s*\)/g)) {
        const axis = axis2placements.get(parseInt(m[2]));
        const radius = parseFloat(m[3]);
        if (!axis) continue;
        const origin = cartesianPoints.get(axis.loc);
        const axisDir = directions.get(axis.z);
        if (origin && axisDir) cylinders.push({ id: parseInt(m[1]), origin, axisDir, radius });
    }

    const cones = [];
    for (const m of text.matchAll(/#(\d+)\s*=\s*CONICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)/g)) {
        const axis = axis2placements.get(parseInt(m[2]));
        if (!axis) continue;
        const origin = cartesianPoints.get(axis.loc);
        const axisDir = directions.get(axis.z);
        if (origin && axisDir) cones.push({ id: parseInt(m[1]), origin, axisDir, radius: parseFloat(m[3]), semiAngle: parseFloat(m[4]) });
    }

    const advFaces = [...text.matchAll(/#\d+\s*=\s*ADVANCED_FACE/g)].length;
    const edgeCurves = [...text.matchAll(/#\d+\s*=\s*EDGE_CURVE/g)].length;
    const orientedEdges = [...text.matchAll(/#\d+\s*=\s*ORIENTED_EDGE/g)].length;
    const edgeLoops = [...text.matchAll(/#\d+\s*=\s*EDGE_LOOP/g)].length;
    const closedShells = [...text.matchAll(/#\d+\s*=\s*CLOSED_SHELL/g)].length;
    const vertexPoints = [...text.matchAll(/#\d+\s*=\s*VERTEX_POINT/g)].length;

    return { planes, cylinders, cones, advFaces, edgeCurves, orientedEdges, edgeLoops, closedShells, vertexPoints };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

const sldFiles = existsSync(sldDir) ? readdirSync(sldDir).filter(f => /\.sldprt$/i.test(f)) : [];
const ctc01File = sldFiles.find(f => f.includes('ctc_01'));
if (!ctc01File) { console.log('No CTC-01 SLDPRT found. Run: npm run download-samples'); process.exit(0); }

const ps = getLargestPS(join(sldDir, ctc01File));
if (!ps) { console.log('Failed to extract Parasolid'); process.exit(1); }
console.log(`Parasolid: ${ps.length} bytes from ${ctc01File}`);

const entities = parseEntities(ps);
console.log(`Parsed ${entities.length} entity records`);

// Census
const census = {};
for (const e of entities) { census[e.type] = (census[e.type] || 0) + 1; }
console.log('\n=== ENTITY CENSUS ===');
for (const [type, count] of Object.entries(census).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const hex = `0x${Number(type).toString(16).padStart(2, '0')}`;
    console.log(`  type ${hex}: ${count}`);
}

// Points
const points = [];
for (const e of entities) {
    if ((e.type & 0xff) !== 0x1d) continue;
    const pt = extractPoint(e);
    if (pt) points.push({ id: e.id, ...pt });
}
console.log(`\nPoints extracted: ${points.length}`);

// Surfaces
const surfaces = [];
for (const e of entities) {
    if ((e.type & 0xff) !== 0x1e) continue;
    const cls = classifySurface(e);
    if (cls) surfaces.push({ id: e.id, ...cls });
}

const psPlanes = surfaces.filter(s => s.surfaceType === 'plane');
const psCylinders = surfaces.filter(s => s.surfaceType === 'cylinder');
const psOther = surfaces.filter(s => s.surfaceType !== 'plane' && s.surfaceType !== 'cylinder');

console.log(`\nSurfaces extracted: ${surfaces.length}`);
console.log(`  Planes: ${psPlanes.length}`);
console.log(`  Cylinders: ${psCylinders.length}`);
console.log(`  Other: ${psOther.length} (types: ${[...new Set(psOther.map(s => s.surfaceType))].join(', ')})`);

// Faces
const faces = [];
for (const e of entities) {
    if ((e.type & 0xff) !== 0x0f) continue;
    const d = e.data;
    const refs = [];
    for (let j = 0; j + 2 <= d.length && j < 16; j += 2) {
        refs.push(d.readUInt16BE(j));
    }
    faces.push({ id: e.id, size: d.length, headerRefs: refs });
}
console.log(`\nFaces: ${faces.length}`);
if (faces.length > 0) {
    for (const f of faces.slice(0, 5)) {
        console.log(`  id=${f.id} size=${f.size} refs=[${f.headerRefs.join(', ')}]`);
    }
}

// Edges
const edges = [];
for (const e of entities) {
    if ((e.type & 0xff) !== 0x10) continue;
    const d = e.data;
    const refs = [];
    for (let j = 0; j + 2 <= d.length && j < 16; j += 2) {
        refs.push(d.readUInt16BE(j));
    }
    edges.push({ id: e.id, size: d.length, headerRefs: refs });
}
console.log(`Edges: ${edges.length}`);

// Loops
const loops = [];
for (const e of entities) {
    if ((e.type & 0xff) !== 0x13) continue;
    loops.push({ id: e.id, size: e.data.length });
}
console.log(`Loops: ${loops.length}`);

// Shells
const shells = [];
for (const e of entities) {
    if ((e.type & 0xff) !== 0x11) continue;
    shells.push({ id: e.id, size: e.data.length });
}
console.log(`Shells/Bodies: ${shells.length}`);

// ── STEP cross-check ────────────────────────────────────────────────────────

const stepFiles = existsSync(ctcDefDir) ? readdirSync(ctcDefDir).filter(f => /ctc.01/i.test(f) && /\.stp$/i.test(f)) : [];
if (stepFiles.length > 0) {
    console.log('\n=== STEP CROSS-CHECK ===');
    const step = parseStepSurfaces(join(ctcDefDir, stepFiles[0]));
    console.log(`STEP: ${stepFiles[0]}`);
    console.log(`  Planes: ${step.planes.length}, Cylinders: ${step.cylinders.length}, Cones: ${step.cones.length}`);
    console.log(`  Faces: ${step.advFaces}, Edges: ${step.edgeCurves}, Loops: ${step.edgeLoops}, Shells: ${step.closedShells}, Vertices: ${step.vertexPoints}`);

    // Match planes
    let planeMatch = 0;
    for (const sp of step.planes) {
        for (const pp of psPlanes) {
            let dx = sp.origin[0]/1000 - pp.origin.x;
            let dy = sp.origin[1]/1000 - pp.origin.y;
            let dz = sp.origin[2]/1000 - pp.origin.z;
            let dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            const dot = Math.abs(sp.normal[0]*pp.normal.x + sp.normal[1]*pp.normal.y + sp.normal[2]*pp.normal.z);
            if (dist < 0.001 && Math.abs(dot - 1) < 0.01) { planeMatch++; break; }
            // Also try direct mm
            dx = sp.origin[0] - pp.origin.x;
            dy = sp.origin[1] - pp.origin.y;
            dz = sp.origin[2] - pp.origin.z;
            dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (dist < 0.1 && Math.abs(dot - 1) < 0.01) { planeMatch++; break; }
        }
    }
    console.log(`  Plane match: ${planeMatch}/${step.planes.length}`);

    let cylMatch = 0;
    for (const sc of step.cylinders) {
        for (const pc of psCylinders) {
            const rDirect = Math.abs(sc.radius - pc.radius) < 0.01;
            const rScaled = Math.abs(sc.radius/1000 - pc.radius) < 0.0001;
            if (!rDirect && !rScaled) continue;
            const dot = Math.abs(sc.axisDir[0]*pc.axis.x + sc.axisDir[1]*pc.axis.y + sc.axisDir[2]*pc.axis.z);
            if (Math.abs(dot - 1) < 0.01) { cylMatch++; break; }
        }
    }
    console.log(`  Cylinder match: ${cylMatch}/${step.cylinders.length}`);

    console.log(`\n  PS vs STEP:`);
    console.log(`    Faces:    ${faces.length} PS vs ${step.advFaces} STEP`);
    console.log(`    Edges:    ${edges.length} PS vs ${step.edgeCurves} STEP`);
    console.log(`    Loops:    ${loops.length} PS vs ${step.edgeLoops} STEP`);
    console.log(`    Points:   ${points.length} PS vs ${step.vertexPoints} STEP`);
    console.log(`    Surfaces: ${surfaces.length} PS vs ${step.planes.length + step.cylinders.length + step.cones.length} STEP`);
    console.log(`    Shells:   ${shells.length} PS vs ${step.closedShells} STEP`);
}

// ── Face → Surface reference analysis ───────────────────────────────────────

const surfaceIds = new Set(surfaces.map(s => s.id));
console.log('\n=== FACE → SURFACE REF ANALYSIS ===');
let faceWithSurfRef = 0;
for (const f of faces) {
    const matchingSurfRefs = f.headerRefs.filter(r => surfaceIds.has(r));
    if (matchingSurfRefs.length > 0) faceWithSurfRef++;
    if (faces.indexOf(f) < 10) {
        console.log(`  face id=${f.id}: refs=[${f.headerRefs.slice(0, 8).join(',')}] surfRefs=[${matchingSurfRefs.join(',')}]`);
    }
}
console.log(`Faces with surface refs: ${faceWithSurfRef}/${faces.length}`);

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== SUMMARY ===');
console.log(`Total entities: ${entities.length}`);
console.log(`Points: ${points.length}, Surfaces: ${surfaces.length}, Faces: ${faces.length}, Edges: ${edges.length}, Loops: ${loops.length}, Shells: ${shells.length}`);
