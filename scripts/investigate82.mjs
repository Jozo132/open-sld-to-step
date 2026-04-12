#!/usr/bin/env node
/**
 * investigate82.mjs — Read FULL FACE entity data to find inline surface geometry.
 *
 * KEY FINDING: All type-0x1E sub-records are edge CURVEs, not face SURFACEs.
 * The surface geometry must be inline in the FACE entity data, after the 0x2B/0x2D marker.
 * This script reads the complete FACE data and extracts float64 geometry params.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const FILE = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const buf = fs.readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
if (!result) { console.log('No PS data'); process.exit(1); }
const ps = result.data;

// Find compact entities sorted by position
function findCompactEntities(buf) {
    const ents = [];
    for (let i = 0; i < buf.length - 9; i++) {
        if (buf[i] !== 0x00) continue;
        const type = buf[i + 1];
        if (type < 0x0F || type > 0x20) continue;
        if (buf[i + 4] !== 0x00 || buf[i + 5] !== 0x00) continue;
        if (buf[i + 8] !== 0x00 || buf[i + 9] !== 0x01) continue;
        const id = buf.readUInt16BE(i + 2);
        if (id === 0 || id > 60000) continue;
        ents.push({ pos: i, type, id, dataStart: i + 10 });
    }
    ents.sort((a, b) => a.pos - b.pos);
    return ents;
}

const allEnts = findCompactEntities(ps);
console.log(`Total compact entities: ${allEnts.length}`);

// For each entity, compute its data length = distance to next entity's header
for (let i = 0; i < allEnts.length; i++) {
    const nextPos = (i + 1 < allEnts.length) ? allEnts[i + 1].pos : ps.length;
    allEnts[i].dataLen = nextPos - allEnts[i].dataStart;
}

// ─── Analyze FACE entity data ────────────────────────────────────────────────
const faces = allEnts.filter(e => e.type === 0x0F);
console.log(`FACE entities: ${faces.length}\n`);

// Read reference STEP for expected plane/cylinder origins to validate
const REF_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');
const refPath = path.join(REF_DIR, 'nist_ctc_01_asme1_rd.stp');
let refPlanes = [];
let refCylinders = [];
if (fs.existsSync(refPath)) {
    const refText = fs.readFileSync(refPath, 'utf-8');
    // Quick parse: find PLANE entities and their axis placements
    const planeRe = /PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g;
    let m;
    while ((m = planeRe.exec(refText)) !== null) {
        refPlanes.push(parseInt(m[1]));
    }
    const cylRe = /CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([\d.eE+-]+)\s*\)/g;
    while ((m = cylRe.exec(refText)) !== null) {
        refCylinders.push({ axis: parseInt(m[1]), radius: parseFloat(m[2]) });
    }
    console.log(`Reference: ${refPlanes.length} planes, ${refCylinders.length} cylinders`);
}

// For each FACE, find geometry markers and extract floats
console.log('\n=== FACE inline geometry analysis ===');

const faceSurfaces = [];
let planesFound = 0;
let cylindersFound = 0;
let unknownGeom = 0;

for (const face of faces) {
    const data = ps.subarray(face.dataStart, face.dataStart + face.dataLen);
    
    // Find 0x2B ('+') and 0x2D ('-') geometry markers in the data
    let geomMarker = -1;
    let markerByte = 0;
    for (let j = 10; j < data.length; j++) { // skip first 10 bytes (ref fields)
        if (data[j] === 0x2B || data[j] === 0x2D) {
            // Verify: after marker, read float64 BE values and check if reasonable
            const remaining = data.length - j - 1;
            if (remaining >= 8) {
                const firstFloat = data.readDoubleBE(j + 1);
                if (isFinite(firstFloat) && Math.abs(firstFloat) < 1e3) {
                    geomMarker = j;
                    markerByte = data[j];
                    break;
                }
            }
        }
    }
    
    if (geomMarker < 0) {
        unknownGeom++;
        continue;
    }
    
    // Read all float64 values after the marker
    const floats = [];
    for (let off = geomMarker + 1; off + 8 <= data.length; off += 8) {
        const val = data.readDoubleBE(off);
        if (!isFinite(val) || Math.abs(val) > 1e6) break;
        floats.push(val);
    }
    
    // Classify by float count
    let surfType = 'unknown';
    let surfParams = {};
    
    if (floats.length === 7 || floats.length === 8) {
        // PLANE or LINE: origin(3) + normal/direction(3) + [0]
        const nx = floats[3], ny = floats[4], nz = floats[5];
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        if (Math.abs(len - 1.0) < 0.1) {
            surfType = 'PLANE';
            surfParams = {
                origin: [floats[0]*1000, floats[1]*1000, floats[2]*1000], // m→mm
                normal: [nx, ny, nz],
            };
            planesFound++;
        }
    } else if (floats.length >= 11) {
        // CYLINDER or CONE
        const semiAngle = floats[10];
        const radius = floats[9] * 1000; // m→mm
        if (Math.abs(semiAngle) < 0.01) {
            surfType = 'CYLINDER';
            surfParams = {
                origin: [floats[0]*1000, floats[1]*1000, floats[2]*1000],
                axis: [floats[3], floats[4], floats[5]],
                radius,
            };
            cylindersFound++;
        } else {
            surfType = 'CONE';
            surfParams = {
                origin: [floats[0]*1000, floats[1]*1000, floats[2]*1000],
                axis: [floats[3], floats[4], floats[5]],
                radius,
                semiAngle,
            };
        }
    }
    
    faceSurfaces.push({ faceId: face.id, surfType, floatCount: floats.length, surfParams, markerByte });
}

console.log(`\nGeometry extraction results:`);
console.log(`  PLANEs: ${planesFound}`);
console.log(`  CYLINDERs: ${cylindersFound}`);
console.log(`  Unknown/no geometry: ${unknownGeom}`);
console.log(`  Total with marker: ${faceSurfaces.length}`);

// ─── Show first 20 faces with geometry ─────────────────────────────────────
console.log('\n=== First 30 faces with inline geometry ===');
for (const fs2 of faceSurfaces.slice(0, 30)) {
    const { faceId, surfType, floatCount, surfParams, markerByte } = fs2;
    const marker = markerByte === 0x2B ? '+' : '-';
    if (surfType === 'PLANE') {
        const { origin, normal } = surfParams;
        console.log(`  FACE#${faceId} [${marker}${floatCount}f] PLANE ` +
            `origin=(${origin.map(v=>v.toFixed(1)).join(',')}) ` +
            `normal=(${normal.map(v=>v.toFixed(4)).join(',')})`);
    } else if (surfType === 'CYLINDER') {
        const { origin, axis, radius } = surfParams;
        console.log(`  FACE#${faceId} [${marker}${floatCount}f] CYLINDER ` +
            `origin=(${origin.map(v=>v.toFixed(1)).join(',')}) ` +
            `axis=(${axis.map(v=>v.toFixed(4)).join(',')}) r=${radius.toFixed(2)}`);
    } else {
        console.log(`  FACE#${faceId} [${marker}${floatCount}f] ${surfType}`);
    }
}

// ─── Deduplicate inline surfaces and compare with reference ─────────────────
console.log('\n=== Unique inline surfaces ===');

const uniquePlanes = [];
const uniqueCylinders = [];

for (const fs3 of faceSurfaces) {
    if (fs3.surfType === 'PLANE') {
        const { origin, normal } = fs3.surfParams;
        const d = normal[0]*origin[0] + normal[1]*origin[1] + normal[2]*origin[2];
        // Check if already exists
        const exists = uniquePlanes.some(p => {
            const dotN = p.normal[0]*normal[0] + p.normal[1]*normal[1] + p.normal[2]*normal[2];
            return Math.abs(Math.abs(dotN) - 1) < 0.02 && Math.abs(Math.abs(p.d) - Math.abs(d)) < 1.0;
        });
        if (!exists) {
            uniquePlanes.push({ normal, d, origin, markerByte: fs3.markerByte, faceId: fs3.faceId });
        }
    } else if (fs3.surfType === 'CYLINDER') {
        const { origin, axis, radius } = fs3.surfParams;
        const exists = uniqueCylinders.some(c => {
            const dotA = c.axis[0]*axis[0] + c.axis[1]*axis[1] + c.axis[2]*axis[2];
            return Math.abs(Math.abs(dotA) - 1) < 0.02 && Math.abs(c.radius - radius) < 0.5;
        });
        if (!exists) {
            uniqueCylinders.push({ origin, axis, radius, faceId: fs3.faceId });
        }
    }
}

console.log(`Unique PLANEs: ${uniquePlanes.length}`);
console.log(`Unique CYLINDERs: ${uniqueCylinders.length}`);
console.log(`\nReference: 80 planes, 57 cylinders`);

// ─── Print unique planes ────────────────────────────────────────────────────
console.log('\n=== Unique planes (first 30) ===');
for (const p of uniquePlanes.slice(0, 30)) {
    const marker = p.markerByte === 0x2B ? '+' : '-';
    console.log(`  [${marker}] origin=(${p.origin.map(v=>v.toFixed(1)).join(',')}) ` +
        `normal=(${p.normal.map(v=>v.toFixed(4)).join(',')}) d=${p.d.toFixed(2)}`);
}

// ─── Print unique cylinders ─────────────────────────────────────────────────
console.log('\n=== Unique cylinders (first 20) ===');
for (const c of uniqueCylinders.slice(0, 20)) {
    console.log(`  origin=(${c.origin.map(v=>v.toFixed(1)).join(',')}) ` +
        `axis=(${c.axis.map(v=>v.toFixed(4)).join(',')}) r=${c.radius.toFixed(2)}`);
}

// ─── Faces with no inline geometry — check what's there ─────────────────────
console.log(`\n=== Faces WITHOUT inline geometry (${unknownGeom}) ===`);
const noGeomFaces = faces.filter(f => {
    const data = ps.subarray(f.dataStart, f.dataStart + f.dataLen);
    for (let j = 10; j < data.length; j++) {
        if (data[j] === 0x2B || data[j] === 0x2D) {
            const remaining = data.length - j - 1;
            if (remaining >= 8) {
                const firstFloat = data.readDoubleBE(j + 1);
                if (isFinite(firstFloat) && Math.abs(firstFloat) < 1e3) return false;
            }
        }
    }
    return true;
});

for (const f of noGeomFaces.slice(0, 10)) {
    const data = ps.subarray(f.dataStart, Math.min(f.dataStart + 60, f.dataStart + f.dataLen));
    const hex = [...data].map(b => b.toString(16).padStart(2,'0')).join(' ');
    console.log(`  FACE#${f.id} (${f.dataLen}B): ${hex}`);
}
