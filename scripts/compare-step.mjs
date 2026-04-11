#!/usr/bin/env node
/**
 * compare-step.mjs — Deep analytical comparison of two STEP (ISO 10303-21) files.
 *
 * Usage:
 *   node scripts/compare-step.mjs <generated.stp> <reference.stp>
 *
 * Can also be imported:
 *   import { compareStepFiles, SCORE_WEIGHTS } from './compare-step.mjs';
 *   const { output, scores, overall } = compareStepFiles(genText, refText, genName, refName);
 *
 * Outputs:
 *   1. Entity count comparison (per type, sorted by delta)
 *   2. Geometric entity deep-match (PLANE, CYLINDRICAL_SURFACE, etc.)
 *      - 1:1 matching by position + parameters
 *      - matched / unmatched / extra counts
 *   3. ADVANCED_FACE match by surface type + area proxy + hole count
 *   4. Vertex (CARTESIAN_POINT in VERTEX_POINT) position matching
 *   5. Summary score
 */
import fs from 'node:fs';
import path from 'node:path';

// ─── STEP Parser ──────────────────────────────────────────────────────────────
/** Parse a STEP file into a map of id → { type, args (raw string) } */
function parseStepEntities(text) {
    const entities = new Map(); // id → { type, args }
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

        const complexMatch = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complexMatch) {
            const types = complexMatch[1].split(',').map(s => s.trim());
            const args = complexMatch[2];
            const compositeType = types.sort().join(',');
            entities.set(id, { type: compositeType, types, args });
            continue;
        }

        const simpleMatch = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simpleMatch) {
            entities.set(id, { type: simpleMatch[1], types: [simpleMatch[1]], args: simpleMatch[2] });
            continue;
        }

        entities.set(id, { type: '???', types: [], args: rest });
    }
    return entities;
}

function parseNumberTuple(str) {
    return str.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
}

function resolveCartesianPoint(entities, id) {
    const e = entities.get(id);
    if (!e) return null;
    if (!e.types.includes('CARTESIAN_POINT')) return null;
    const m = e.args.match(/\(\s*([^)]+)\s*\)/);
    if (!m) return null;
    return parseNumberTuple(m[1]);
}

function resolveDirection(entities, id) {
    const e = entities.get(id);
    if (!e) return null;
    if (!e.types.includes('DIRECTION')) return null;
    const m = e.args.match(/\(\s*([^)]+)\s*\)/);
    if (!m) return null;
    const v = parseNumberTuple(m[1]);
    if (!v) return null;
    // Normalize — some STEP files store non-unit direction vectors
    const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    if (len < 1e-15) return v;
    return [v[0]/len, v[1]/len, v[2]/len];
}

function resolveAxis2Placement(entities, id) {
    const e = entities.get(id);
    if (!e) return null;
    if (!e.types.includes('AXIS2_PLACEMENT_3D')) return null;
    const refs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
    const origin = refs[0] ? resolveCartesianPoint(entities, refs[0]) : null;
    const axis = refs[1] ? resolveDirection(entities, refs[1]) : null;
    const refDir = refs[2] ? resolveDirection(entities, refs[2]) : null;
    return { origin, axis, refDir };
}

// ─── Geometry extraction ──────────────────────────────────────────────────────
function extractGeometry(entities) {
    const geom = {
        planes: [], cylinders: [], cones: [], spheres: [],
        toroids: [], bsplineSurfaces: [], circles: [], lines: [],
    };

    for (const [id, e] of entities) {
        if (e.types.includes('PLANE')) {
            const axRef = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10))[0];
            const ax = axRef ? resolveAxis2Placement(entities, axRef) : null;
            if (ax?.origin && ax?.axis) {
                const n = ax.axis, o = ax.origin;
                const d = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
                geom.planes.push({ id, origin: o, normal: n, d });
            }
        }
        else if (e.types.includes('CYLINDRICAL_SURFACE')) {
            const parts = e.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)/);
            if (parts) {
                const ax = resolveAxis2Placement(entities, parseInt(parts[1], 10));
                if (ax?.origin && ax?.axis) {
                    geom.cylinders.push({ id, origin: ax.origin, axis: ax.axis, refDir: ax.refDir, radius: parseFloat(parts[2]) });
                }
            }
        }
        else if (e.types.includes('CONICAL_SURFACE')) {
            const parts = e.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
            if (parts) {
                const ax = resolveAxis2Placement(entities, parseInt(parts[1], 10));
                if (ax?.origin && ax?.axis) {
                    geom.cones.push({ id, origin: ax.origin, axis: ax.axis, radius: parseFloat(parts[2]), semiAngle: parseFloat(parts[3]) });
                }
            }
        }
        else if (e.types.includes('SPHERICAL_SURFACE')) {
            const parts = e.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)/);
            if (parts) {
                const ax = resolveAxis2Placement(entities, parseInt(parts[1], 10));
                if (ax?.origin) geom.spheres.push({ id, origin: ax.origin, radius: parseFloat(parts[2]) });
            }
        }
        else if (e.types.includes('TOROIDAL_SURFACE')) {
            const parts = e.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
            if (parts) {
                const ax = resolveAxis2Placement(entities, parseInt(parts[1], 10));
                if (ax?.origin && ax?.axis) {
                    geom.toroids.push({ id, origin: ax.origin, axis: ax.axis, majorR: parseFloat(parts[2]), minorR: parseFloat(parts[3]) });
                }
            }
        }
        else if (e.types.includes('CIRCLE')) {
            const parts = e.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)/);
            if (parts) {
                const ax = resolveAxis2Placement(entities, parseInt(parts[1], 10));
                if (ax?.origin) geom.circles.push({ id, origin: ax.origin, normal: ax.axis, radius: parseFloat(parts[2]) });
            }
        }
        else if (e.types.includes('LINE')) {
            const refs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
            const pt = refs[0] ? resolveCartesianPoint(entities, refs[0]) : null;
            if (pt) geom.lines.push({ id, origin: pt });
        }
    }
    return geom;
}

// ─── ADVANCED_FACE extraction ─────────────────────────────────────────────────
function extractFaces(entities) {
    const faces = [];
    for (const [id, e] of entities) {
        if (!e.types.includes('ADVANCED_FACE')) continue;
        const boundsMatch = e.args.match(/\(([^)]*)\)/);
        const allRefs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
        const boundRefs = boundsMatch
            ? [...boundsMatch[1].matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10))
            : [];

        const senseMatch = e.args.match(/,\s*#(\d+)\s*,\s*\.[TF]\.\s*$/);
        const surfRef = senseMatch ? parseInt(senseMatch[1], 10) : allRefs[allRefs.length - 1];
        const surfEnt = entities.get(surfRef);
        const surfType = surfEnt ? surfEnt.types.find(t =>
            ['PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'SPHERICAL_SURFACE',
             'TOROIDAL_SURFACE', 'B_SPLINE_SURFACE_WITH_KNOTS'].includes(t)
        ) ?? surfEnt.type : 'UNKNOWN';

        let outerCount = 0, innerCount = 0;
        for (const bRef of boundRefs) {
            const be = entities.get(bRef);
            if (!be) continue;
            if (be.types.includes('FACE_OUTER_BOUND')) outerCount++;
            else if (be.types.includes('FACE_BOUND')) innerCount++;
        }

        let surfGeom = null;
        if (surfEnt?.types.includes('PLANE')) {
            const axRef = [...surfEnt.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10))[0];
            const ax = axRef ? resolveAxis2Placement(entities, axRef) : null;
            if (ax?.origin && ax?.axis) {
                const n = ax.axis, o = ax.origin;
                surfGeom = { surfType: 'PLANE', normal: n, d: n[0]*o[0]+n[1]*o[1]+n[2]*o[2], origin: o };
            }
        } else if (surfEnt?.types.includes('CYLINDRICAL_SURFACE')) {
            const parts = surfEnt.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)/);
            if (parts) {
                const ax = resolveAxis2Placement(entities, parseInt(parts[1], 10));
                if (ax?.origin && ax?.axis) surfGeom = { surfType: 'CYLINDRICAL_SURFACE', origin: ax.origin, axis: ax.axis, radius: parseFloat(parts[2]) };
            }
        } else if (surfEnt?.types.includes('CONICAL_SURFACE')) {
            const parts = surfEnt.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
            if (parts) {
                const ax = resolveAxis2Placement(entities, parseInt(parts[1], 10));
                if (ax?.origin && ax?.axis) surfGeom = { surfType: 'CONICAL_SURFACE', origin: ax.origin, axis: ax.axis, radius: parseFloat(parts[2]), semiAngle: parseFloat(parts[3]) };
            }
        }

        const faceVertices = [];
        for (const bRef of boundRefs) {
            const be = entities.get(bRef);
            if (!be) continue;
            const loopRef = [...be.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10))[0];
            const loopEnt = loopRef ? entities.get(loopRef) : null;
            if (!loopEnt?.types.includes('EDGE_LOOP')) continue;
            const oedgeRefs = [...loopEnt.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
            for (const oeRef of oedgeRefs) {
                const oe = entities.get(oeRef);
                if (!oe?.types.includes('ORIENTED_EDGE')) continue;
                const oeRefs = [...oe.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
                const ecRef = oeRefs[oeRefs.length - 1];
                const ec = ecRef ? entities.get(ecRef) : null;
                if (!ec?.types.includes('EDGE_CURVE')) continue;
                const ecRefs = [...ec.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
                for (const vref of ecRefs.slice(0, 2)) {
                    const ve = entities.get(vref);
                    if (!ve?.types.includes('VERTEX_POINT')) continue;
                    const ptRef = [...ve.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10))[0];
                    const pt = ptRef ? resolveCartesianPoint(entities, ptRef) : null;
                    if (pt) faceVertices.push(pt);
                }
            }
        }

        let bboxDiag = 0, centroid = null;
        if (faceVertices.length >= 2) {
            let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = Infinity, mxZ = -Infinity;
            let sx = 0, sy = 0, sz = 0;
            for (const v of faceVertices) {
                if (v[0] < mnX) mnX = v[0]; if (v[0] > mxX) mxX = v[0];
                if (v[1] < mnY) mnY = v[1]; if (v[1] > mxY) mxY = v[1];
                if (v[2] < mnZ) mnZ = v[2]; if (v[2] > mxZ) mxZ = v[2];
                sx += v[0]; sy += v[1]; sz += v[2];
            }
            bboxDiag = Math.sqrt((mxX-mnX)**2 + (mxY-mnY)**2 + (mxZ-mnZ)**2);
            centroid = [sx / faceVertices.length, sy / faceVertices.length, sz / faceVertices.length];
        }

        faces.push({ id, surfType, surfRef, outerCount, innerCount, bboxDiag, centroid, surfGeom, vertexCount: faceVertices.length });
    }
    return faces;
}

// ─── Vertex extraction ────────────────────────────────────────────────────────
function extractVertexPoints(entities) {
    const verts = [];
    for (const [id, e] of entities) {
        if (!e.types.includes('VERTEX_POINT')) continue;
        const ptRef = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10))[0];
        const pt = ptRef ? resolveCartesianPoint(entities, ptRef) : null;
        if (pt) verts.push({ id, position: pt });
    }
    return verts;
}

// ─── Matching helpers ─────────────────────────────────────────────────────────
function dist3(a, b) {
    return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
}

function dirMatch(a, b, tol = 0.01) {
    const dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
    return Math.abs(Math.abs(dot) - 1.0) < tol;
}

function greedyMatch(genArr, refArr, distFn, maxDist) {
    const candidates = [];
    for (let gi = 0; gi < genArr.length; gi++) {
        for (let ri = 0; ri < refArr.length; ri++) {
            const d = distFn(genArr[gi], refArr[ri]);
            if (d <= maxDist) candidates.push({ gi, ri, d });
        }
    }
    candidates.sort((a, b) => a.d - b.d);

    const usedGen = new Set(), usedRef = new Set();
    const matched = [];
    for (const c of candidates) {
        if (usedGen.has(c.gi) || usedRef.has(c.ri)) continue;
        usedGen.add(c.gi); usedRef.add(c.ri);
        matched.push({ gen: genArr[c.gi], ref: refArr[c.ri], dist: c.d });
    }

    const unmatchedGen = genArr.filter((_, i) => !usedGen.has(i));
    const unmatchedRef = refArr.filter((_, i) => !usedRef.has(i));
    return { matched, unmatchedGen, unmatchedRef };
}

function planeDist(a, b) {
    const dot = a.normal[0]*b.normal[0] + a.normal[1]*b.normal[1] + a.normal[2]*b.normal[2];
    if (Math.abs(Math.abs(dot) - 1.0) > 0.02) return Infinity;
    const bD = dot > 0 ? b.d : -b.d;
    return Math.abs(a.d - bD);
}

function cylinderDist(a, b) {
    const dot = a.axis[0]*b.axis[0] + a.axis[1]*b.axis[1] + a.axis[2]*b.axis[2];
    if (Math.abs(Math.abs(dot) - 1.0) > 0.02) return Infinity;
    if (Math.abs(a.radius - b.radius) > 0.5) return Infinity;
    const dx = a.origin[0]-b.origin[0], dy = a.origin[1]-b.origin[1], dz = a.origin[2]-b.origin[2];
    const along = dx*a.axis[0] + dy*a.axis[1] + dz*a.axis[2];
    const perpSq = dx*dx + dy*dy + dz*dz - along*along;
    return Math.sqrt(Math.max(0, perpSq)) + Math.abs(a.radius - b.radius);
}

function coneDist(a, b) {
    if (!dirMatch(a.axis, b.axis, 0.02)) return Infinity;
    if (Math.abs(a.radius - b.radius) > 0.5) return Infinity;
    if (Math.abs(a.semiAngle - b.semiAngle) > 0.05) return Infinity;
    return dist3(a.origin, b.origin);
}

function faceDist(a, b) {
    if (a.surfType !== b.surfType) return Infinity;
    const holePenalty = Math.abs(a.innerCount - b.innerCount) * 10;
    let centroidDist = 0;
    if (a.centroid && b.centroid) centroidDist = dist3(a.centroid, b.centroid);
    else centroidDist = 50;
    let geomDist = 0;
    if (a.surfGeom && b.surfGeom) {
        if (a.surfGeom.surfType === 'PLANE' && b.surfGeom.surfType === 'PLANE') {
            const dot = a.surfGeom.normal[0]*b.surfGeom.normal[0] + a.surfGeom.normal[1]*b.surfGeom.normal[1] + a.surfGeom.normal[2]*b.surfGeom.normal[2];
            if (Math.abs(Math.abs(dot) - 1.0) > 0.05) return Infinity;
            const bD = dot > 0 ? b.surfGeom.d : -b.surfGeom.d;
            geomDist = Math.abs(a.surfGeom.d - bD);
            if (geomDist > 2.0) return Infinity;
        } else if (a.surfGeom.surfType === 'CYLINDRICAL_SURFACE' && b.surfGeom.surfType === 'CYLINDRICAL_SURFACE') {
            const dot = a.surfGeom.axis[0]*b.surfGeom.axis[0] + a.surfGeom.axis[1]*b.surfGeom.axis[1] + a.surfGeom.axis[2]*b.surfGeom.axis[2];
            if (Math.abs(Math.abs(dot) - 1.0) > 0.05) return Infinity;
            if (Math.abs(a.surfGeom.radius - b.surfGeom.radius) > 0.5) return Infinity;
            geomDist = Math.abs(a.surfGeom.radius - b.surfGeom.radius);
        }
    }
    return centroidDist + holePenalty + geomDist;
}

function countByType(entities) {
    const counts = {};
    for (const [, e] of entities) {
        for (const t of e.types) counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
}

function describeGeom(g) {
    if (g.normal && g.d !== undefined) return `n=(${fmtV(g.normal)}) d=${g.d.toFixed(1)} origin=(${fmtV(g.origin)})`;
    if (g.axis && g.radius !== undefined && g.semiAngle !== undefined) return `axis=(${fmtV(g.axis)}) r=${g.radius.toFixed(2)} semiAngle=${g.semiAngle.toFixed(3)} origin=(${fmtV(g.origin)})`;
    if (g.axis && g.radius !== undefined) return `axis=(${fmtV(g.axis)}) r=${g.radius.toFixed(2)} origin=(${fmtV(g.origin)})`;
    if (g.origin && g.radius !== undefined) return `r=${g.radius.toFixed(2)} origin=(${fmtV(g.origin)})`;
    if (g.origin) return `origin=(${fmtV(g.origin)})`;
    return JSON.stringify(g);
}
function fmtV(v) { return v.map(x => x.toFixed(1)).join(','); }

// ═══════════════════════════════════════════════════════════════════════════════
//  Exported comparison function + score weights
// ═══════════════════════════════════════════════════════════════════════════════

export const SCORE_WEIGHTS = {
    'Planes': 3,
    'Cylinders': 3,
    'Cones': 2,
    'Faces': 4,
    'HolesExact': 2,
    'InnerLoops': 2,
    'Vertices': 1,
    'Circles': 1,
};

/**
 * Detect the length unit of a STEP file.
 * Returns a scale factor to convert to mm.
 */
function detectLengthUnitScale(text) {
    // Check for CONVERSION_BASED_UNIT with INCH
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    // Check for SI_UNIT with MILLI METRE (mm)
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1.0;
    // Check for SI_UNIT with just METRE (no prefix = meters)
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000.0;
    // Default: assume mm
    return 1.0;
}

/** Scale all geometry values (positions, radii) by a factor. */
function scaleGeometry(geom, factor) {
    if (factor === 1.0) return geom;
    const sp = (pt) => pt ? pt.map(v => v * factor) : pt;
    return {
        planes: geom.planes.map(p => ({
            ...p,
            origin: sp(p.origin),
            d: p.d * factor,
        })),
        cylinders: geom.cylinders.map(c => ({
            ...c,
            origin: sp(c.origin),
            radius: c.radius * factor,
        })),
        cones: geom.cones.map(c => ({
            ...c,
            origin: sp(c.origin),
            radius: c.radius * factor,
        })),
        spheres: geom.spheres.map(s => ({
            ...s,
            origin: sp(s.origin),
            radius: s.radius * factor,
        })),
        toroids: geom.toroids.map(t => ({
            ...t,
            origin: sp(t.origin),
            majorR: t.majorR * factor,
            minorR: t.minorR * factor,
        })),
        bsplineSurfaces: geom.bsplineSurfaces,
        circles: geom.circles.map(c => ({
            ...c,
            origin: sp(c.origin),
            radius: c.radius * factor,
        })),
        lines: geom.lines.map(l => ({
            ...l,
            origin: sp(l.origin),
        })),
    };
}

/** Scale face geometry by a factor. */
function scaleFaces(faces, factor) {
    if (factor === 1.0) return faces;
    const sp = (pt) => pt ? pt.map(v => v * factor) : pt;
    return faces.map(f => {
        const nf = { ...f };
        if (f.surfGeom) {
            const sg = { ...f.surfGeom };
            if (sg.origin) sg.origin = sg.origin.map(v => v * factor);
            if (sg.d !== undefined) sg.d *= factor;
            if (sg.radius !== undefined) sg.radius *= factor;
            nf.surfGeom = sg;
        }
        if (f.centroid) nf.centroid = sp(f.centroid);
        if (f.bboxDiag !== undefined) nf.bboxDiag = f.bboxDiag * factor;
        return nf;
    });
}

/** Scale vertex positions by a factor. */
function scaleVertices(verts, factor) {
    if (factor === 1.0) return verts;
    return verts.map(v => ({
        ...v,
        coords: v.coords.map(c => c * factor),
    }));
}

/**
 * Compare two STEP files and return structured results + printable output.
 * @param {string} genText  - Generated STEP file content
 * @param {string} refText  - Reference STEP file content
 * @param {string} genName  - Display name for generated file
 * @param {string} refName  - Display name for reference file
 * @returns {{ output: string, scores: Record<string, {matched:number,total:number,pct:number}>, overall: string }}
 */
export function compareStepFiles(genText, refText, genName = 'generated', refName = 'reference') {
    const lines = [];
    const log = (s = '') => lines.push(s);

    log('═══════════════════════════════════════════════════════════════');
    log(`  STEP Comparison: Deep Analytical Gap Analysis`);
    log(`  Generated: ${genName}`);
    log(`  Reference: ${refName}`);
    log('═══════════════════════════════════════════════════════════════\n');

    const genEntities = parseStepEntities(genText);
    const refEntities = parseStepEntities(refText);
    log(`Parsed entities: generated=${genEntities.size}, reference=${refEntities.size}\n`);

    // ──── 1. Entity Count Comparison ────────────────────────────────────────
    const genCounts = countByType(genEntities);
    const refCounts = countByType(refEntities);
    const allTypes = new Set([...Object.keys(genCounts), ...Object.keys(refCounts)]);
    const INTERESTING_TYPES = [
        'PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'SPHERICAL_SURFACE',
        'TOROIDAL_SURFACE', 'B_SPLINE_SURFACE_WITH_KNOTS',
        'ADVANCED_FACE', 'FACE_OUTER_BOUND', 'FACE_BOUND',
        'EDGE_LOOP', 'EDGE_CURVE', 'ORIENTED_EDGE',
        'VERTEX_POINT', 'CARTESIAN_POINT', 'DIRECTION',
        'LINE', 'CIRCLE', 'CLOSED_SHELL', 'MANIFOLD_SOLID_BREP', 'AXIS2_PLACEMENT_3D',
    ];

    log('─── 1. ENTITY COUNT COMPARISON ────────────────────────────────');
    log(`${'Entity Type'.padEnd(40)} ${'Gen'.padStart(6)} ${'Ref'.padStart(6)} ${'Delta'.padStart(7)} ${'%Match'.padStart(7)}`);
    log('─'.repeat(68));

    const countRows = [];
    for (const t of allTypes) {
        const g = genCounts[t] || 0, r = refCounts[t] || 0;
        const delta = g - r;
        const pct = r > 0 ? Math.min(g, r) / Math.max(g, r) * 100 : (g === 0 ? 100 : 0);
        countRows.push({ type: t, g, r, delta, pct });
    }
    const interesting = countRows.filter(r => INTERESTING_TYPES.includes(r.type)).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const other = countRows.filter(r => !INTERESTING_TYPES.includes(r.type) && Math.abs(r.delta) > 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    for (const row of interesting) {
        const deltaStr = row.delta > 0 ? `+${row.delta}` : `${row.delta}`;
        const pctStr = row.pct.toFixed(0) + '%';
        const marker = row.pct >= 95 ? '✓' : row.pct >= 70 ? '~' : '✗';
        log(`${marker} ${row.type.padEnd(38)} ${String(row.g).padStart(6)} ${String(row.r).padStart(6)} ${deltaStr.padStart(7)} ${pctStr.padStart(7)}`);
    }
    if (other.length > 0) {
        log('  --- other types with differences ---');
        for (const row of other.slice(0, 15)) {
            const deltaStr = row.delta > 0 ? `+${row.delta}` : `${row.delta}`;
            log(`  ${row.type.padEnd(38)} ${String(row.g).padStart(6)} ${String(row.r).padStart(6)} ${deltaStr.padStart(7)}`);
        }
    }

    // ──── 2. Geometric Surface Matching ─────────────────────────────────────
    log('\n─── 2. GEOMETRIC SURFACE 1:1 MATCHING ─────────────────────────');
    const genScale = detectLengthUnitScale(genText);
    const refScale = detectLengthUnitScale(refText);
    // Normalize both to mm
    let genGeom = extractGeometry(genEntities);
    let refGeom = extractGeometry(refEntities);
    if (genScale !== 1.0) genGeom = scaleGeometry(genGeom, genScale);
    if (refScale !== 1.0) refGeom = scaleGeometry(refGeom, refScale);
    log(`  Units: generated=${genScale === 1 ? 'mm' : genScale === 25.4 ? 'in' : genScale + 'x'}  reference=${refScale === 1 ? 'mm' : refScale === 25.4 ? 'in' : refScale + 'x'}`);


    function reportMatch(label, genArr, refArr, distFn, maxDist) {
        const result = greedyMatch(genArr, refArr, distFn, maxDist);
        const total = Math.max(genArr.length, refArr.length);
        const matchPct = total > 0 ? (result.matched.length / total * 100).toFixed(1) : '100.0';
        const avgDist = result.matched.length > 0
            ? (result.matched.reduce((s, m) => s + m.dist, 0) / result.matched.length).toFixed(3) : 'N/A';

        log(`\n  ${label}:`);
        log(`    Generated: ${genArr.length}  |  Reference: ${refArr.length}`);
        log(`    Matched:   ${result.matched.length} / ${total}  (${matchPct}%)    avg dist: ${avgDist}`);
        log(`    Unmatched generated: ${result.unmatchedGen.length}    Unmatched reference: ${result.unmatchedRef.length}`);

        if (result.matched.length > 0) {
            const worst = result.matched.slice().sort((a, b) => b.dist - a.dist).slice(0, 3);
            if (worst[0].dist > 0.01) {
                log(`    Worst matches:`);
                for (const w of worst) log(`      dist=${w.dist.toFixed(3)}  gen: ${describeGeom(w.gen)}`);
            }
        }
        if (result.unmatchedRef.length > 0 && result.unmatchedRef.length <= 20) {
            log(`    Unmatched reference entities:`);
            for (const ur of result.unmatchedRef.slice(0, 10)) log(`      #${ur.id}: ${describeGeom(ur)}`);
        }
        return result;
    }

    const planeResult = reportMatch('PLANE', genGeom.planes, refGeom.planes, planeDist, 1.0);
    const cylResult = reportMatch('CYLINDRICAL_SURFACE', genGeom.cylinders, refGeom.cylinders, cylinderDist, 2.0);
    const coneResult = reportMatch('CONICAL_SURFACE', genGeom.cones, refGeom.cones, coneDist, 5.0);
    reportMatch('SPHERICAL_SURFACE', genGeom.spheres, refGeom.spheres,
        (a, b) => Math.abs(a.radius - b.radius) < 0.5 ? dist3(a.origin, b.origin) : Infinity, 5.0);
    reportMatch('CIRCLE (curve)', genGeom.circles, refGeom.circles,
        (a, b) => Math.abs(a.radius - b.radius) > 0.5 ? Infinity : dist3(a.origin, b.origin), 5.0);

    // ──── 3. ADVANCED_FACE Matching ─────────────────────────────────────────
    log('\n─── 3. ADVANCED_FACE 1:1 MATCHING ─────────────────────────────');
    let genFaces = extractFaces(genEntities);
    let refFaces = extractFaces(refEntities);
    if (genScale !== 1.0) genFaces = scaleFaces(genFaces, genScale);
    if (refScale !== 1.0) refFaces = scaleFaces(refFaces, refScale);
    const faceResult = greedyMatch(genFaces, refFaces, faceDist, 200);
    const faceTotal = Math.max(genFaces.length, refFaces.length);
    const faceMatchPct = faceTotal > 0 ? (faceResult.matched.length / faceTotal * 100).toFixed(1) : '100.0';
    const avgFaceDist = faceResult.matched.length > 0
        ? (faceResult.matched.reduce((s, m) => s + m.dist, 0) / faceResult.matched.length).toFixed(1) : 'N/A';

    log(`  Generated: ${genFaces.length}  |  Reference: ${refFaces.length}`);
    log(`  Matched:   ${faceResult.matched.length} / ${faceTotal}  (${faceMatchPct}%)    avg dist: ${avgFaceDist}`);
    log(`  Unmatched generated: ${faceResult.unmatchedGen.length}    Unmatched reference: ${faceResult.unmatchedRef.length}`);

    const matchBySurfType = {};
    for (const m of faceResult.matched) { const t = m.ref.surfType; if (!matchBySurfType[t]) matchBySurfType[t] = { matched: 0, total: 0 }; matchBySurfType[t].matched++; }
    for (const f of refFaces) { const t = f.surfType; if (!matchBySurfType[t]) matchBySurfType[t] = { matched: 0, total: 0 }; matchBySurfType[t].total++; }
    log(`\n  Face match by surface type:`);
    log(`  ${'Surface Type'.padEnd(30)} ${'Matched'.padStart(8)} ${'Ref Total'.padStart(10)} ${'%'.padStart(6)}`);
    for (const [t, v] of Object.entries(matchBySurfType).sort((a, b) => b[1].total - a[1].total)) {
        const pct = v.total > 0 ? (v.matched / v.total * 100).toFixed(0) : '100';
        log(`  ${t.padEnd(30)} ${String(v.matched).padStart(8)} ${String(v.total).padStart(10)} ${(pct + '%').padStart(6)}`);
    }

    const genTotalInner = genFaces.reduce((s, f) => s + f.innerCount, 0);
    const refTotalInner = refFaces.reduce((s, f) => s + f.innerCount, 0);
    log(`\n  Inner loops (holes):  generated=${genTotalInner}  reference=${refTotalInner}`);

    let holeExactMatch = 0, holeDiffMatch = 0;
    for (const m of faceResult.matched) { if (m.gen.innerCount === m.ref.innerCount) holeExactMatch++; else holeDiffMatch++; }
    log(`  Matched faces with exact hole count: ${holeExactMatch} / ${faceResult.matched.length}`);
    log(`  Matched faces with different hole count: ${holeDiffMatch}`);

    const holesMismatch = faceResult.matched.filter(m => m.gen.innerCount !== m.ref.innerCount)
        .sort((a, b) => Math.abs(b.gen.innerCount - b.ref.innerCount) - Math.abs(a.gen.innerCount - a.ref.innerCount));
    if (holesMismatch.length > 0) {
        log(`\n  Biggest hole count mismatches:`);
        for (const m of holesMismatch.slice(0, 8)) {
            const sg = m.gen.surfGeom ? describeGeom(m.gen.surfGeom) : m.gen.surfType;
            log(`    gen_holes=${m.gen.innerCount} ref_holes=${m.ref.innerCount}  [${m.gen.surfType}] ${sg}`);
        }
    }
    if (faceResult.unmatchedRef.length > 0) {
        log(`\n  Unmatched reference faces (first 15):`);
        for (const f of faceResult.unmatchedRef.slice(0, 15)) {
            const sg = f.surfGeom ? describeGeom(f.surfGeom) : '';
            log(`    #${f.id}: ${f.surfType} inner=${f.innerCount} bbox=${f.bboxDiag.toFixed(0)} ${sg}`);
        }
    }

    // ──── 4. Vertex Position Matching ───────────────────────────────────────
    log('\n─── 4. VERTEX POSITION 1:1 MATCHING ───────────────────────────');
    let genVerts = extractVertexPoints(genEntities);
    let refVerts = extractVertexPoints(refEntities);
    if (genScale !== 1.0) genVerts = genVerts.map(v => ({ ...v, position: v.position.map(c => c * genScale) }));
    if (refScale !== 1.0) refVerts = refVerts.map(v => ({ ...v, position: v.position.map(c => c * refScale) }));
    const vtxResult = greedyMatch(genVerts, refVerts, (a, b) => dist3(a.position, b.position), 1.0);
    const vtxTotal = Math.max(genVerts.length, refVerts.length);
    const vtxMatchPct = vtxTotal > 0 ? (vtxResult.matched.length / vtxTotal * 100).toFixed(1) : '100.0';
    const avgVtxDist = vtxResult.matched.length > 0
        ? (vtxResult.matched.reduce((s, m) => s + m.dist, 0) / vtxResult.matched.length).toFixed(4) : 'N/A';

    log(`  Generated: ${genVerts.length}  |  Reference: ${refVerts.length}`);
    log(`  Matched:   ${vtxResult.matched.length} / ${vtxTotal}  (${vtxMatchPct}%)    avg dist: ${avgVtxDist}`);
    log(`  Unmatched generated: ${vtxResult.unmatchedGen.length}    Unmatched reference: ${vtxResult.unmatchedRef.length}`);

    if (vtxResult.matched.length > 0) {
        const dists = vtxResult.matched.map(m => m.dist).sort((a, b) => a - b);
        const p50 = dists[Math.floor(dists.length * 0.5)];
        const p90 = dists[Math.floor(dists.length * 0.9)];
        const p99 = dists[Math.floor(dists.length * 0.99)];
        const maxD = dists[dists.length - 1];
        const exact = dists.filter(d => d < 0.001).length;
        log(`  Distance distribution:  exact(<0.001mm)=${exact}  P50=${p50.toFixed(4)}  P90=${p90.toFixed(4)}  P99=${p99.toFixed(4)}  max=${maxD.toFixed(4)}`);
    }

    // ──── 5. Build scores object ────────────────────────────────────────────
    const circleMatchResult = genGeom.circles.length > 0
        ? greedyMatch(genGeom.circles, refGeom.circles, (a, b) => Math.abs(a.radius - b.radius) > 0.5 ? Infinity : dist3(a.origin, b.origin), 5.0)
        : { matched: [] };

    const scoreEntries = [
        ['Planes',     planeResult.matched.length,             Math.max(genGeom.planes.length, refGeom.planes.length)],
        ['Cylinders',  cylResult.matched.length,               Math.max(genGeom.cylinders.length, refGeom.cylinders.length)],
        ['Cones',      coneResult.matched.length,              Math.max(genGeom.cones.length, refGeom.cones.length)],
        ['Faces',      faceResult.matched.length,              faceTotal],
        ['HolesExact', holeExactMatch,                         faceResult.matched.length || 1],
        ['InnerLoops', Math.min(genTotalInner, refTotalInner), Math.max(genTotalInner, refTotalInner) || 1],
        ['Vertices',   vtxResult.matched.length,               vtxTotal],
        ['Circles',    circleMatchResult.matched.length,       Math.max(genGeom.circles.length, refGeom.circles.length) || 1],
    ];

    const scores = {};
    for (const [label, matched, total] of scoreEntries) {
        const pct = total > 0 ? matched / total * 100 : 100;
        scores[label] = { matched, total, pct };
    }

    // ──── 6. Summary Score ──────────────────────────────────────────────────
    log('\n═══════════════════════════════════════════════════════════════');
    log('  SUMMARY SCORE');
    log('═══════════════════════════════════════════════════════════════');

    let totalWeightedScore = 0, totalWeight = 0;
    log(`${'Metric'.padEnd(16)} ${'Score'.padStart(6)} ${'Weight'.padStart(7)} ${'Weighted'.padStart(9)}`);
    log('─'.repeat(53));

    for (const [label, data] of Object.entries(scores)) {
        const w = SCORE_WEIGHTS[label] || 1;
        totalWeightedScore += data.pct * w;
        totalWeight += w * 100;
        const bar = '█'.repeat(Math.round(data.pct / 5)) + '░'.repeat(20 - Math.round(data.pct / 5));
        log(`${label.padEnd(16)} ${(data.pct.toFixed(1) + '%').padStart(6)} ${('×' + w).padStart(7)}   ${bar} ${data.matched}/${data.total}`);
    }

    const overall = totalWeight > 0 ? (totalWeightedScore / totalWeight * 100).toFixed(1) : '0.0';
    log('─'.repeat(53));
    log(`${'OVERALL:'.padEnd(16)} ${(overall + '%').padStart(6)}`);
    log('═══════════════════════════════════════════════════════════════\n');

    return { output: lines.join('\n'), scores, overall };
}

// ─── CLI entry point ────────────────────────────────────────────────────────
const [,, cliGenPath, cliRefPath] = process.argv;
if (cliGenPath && cliRefPath) {
    const genText = fs.readFileSync(cliGenPath, 'utf8');
    const refText = fs.readFileSync(cliRefPath, 'utf8');
    const { output } = compareStepFiles(genText, refText, path.basename(cliGenPath), path.basename(cliRefPath));
    console.log(output);
}
