#!/usr/bin/env node
// Clean-room analysis of public-domain NIST test files.
/**
 * investigate84.mjs — Analyze type 0x1F (SURFACE) entity float counts
 * 
 * Hypothesis: PLANE surface geometry is stored in type 0x1F entities with
 * 7 floats, but the parser only extracts 0x1F entities with ≥11 floats
 * (cylinders/cones), silently dropping planes.
 * 
 * This script counts float lengths for both 0x1E and 0x1F entities to
 * verify whether 7-float 0x1F entities correspond to reference planes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const files = fs.readdirSync(NIST_DIR).filter(f => /\.sldprt$/i.test(f)).sort();

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

function readGeomFloats(data) {
    for (const marker of [0x2b, 0x2d]) {
        const markerIdx = data.indexOf(marker);
        if (markerIdx < 0 || markerIdx + 1 + 8 > data.length) continue;
        const floats = [];
        for (let off = markerIdx + 1; off + 8 <= data.length; off += 8) {
            const val = data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }
        if (floats.length >= 3) return { floats, marker };
    }
    return null;
}

function extractAllEntities(psBuf) {
    const entities = [];
    const sentPositions = [];
    let idx = 0;
    while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) {
        sentPositions.push(idx);
        idx += SENTINEL.length;
    }
    if (sentPositions.length === 0) return entities;

    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + SENTINEL.length;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : psBuf.length;
        const block = psBuf.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        const subRecords = [];
        let searchStart = 0;
        while (true) {
            const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
            if (sepIdx < 0) { subRecords.push(block.subarray(searchStart)); break; }
            subRecords.push(block.subarray(searchStart, sepIdx));
            searchStart = sepIdx + SUB_RECORD_SEP.length;
        }

        for (let si = 0; si < subRecords.length; si++) {
            const rec = subRecords[si];
            if (si === 0) {
                if (rec.length < 8) continue;
                if (rec.readUInt32BE(0) !== 3) continue;
                const type = rec[5];
                if (type < 0x0d || type > 0x3f) continue;
                const id = rec.readUInt16BE(6);
                entities.push({ type, id, data: rec.subarray(8) });
            } else {
                if (rec.length < 4) continue;
                if (rec[0] !== 0x00) continue;
                const type = rec[1];
                if (type < 0x0d || type > 0x3f) continue;
                const id = rec.readUInt16BE(2);
                entities.push({ type, id, data: rec.subarray(4) });
            }
        }
    }
    return entities;
}

// Analyze each file
console.log('=== Type 0x1E vs 0x1F float count distribution ===\n');

for (const fname of files) {
    const buf = fs.readFileSync(path.join(NIST_DIR, fname));
    const result = SldprtContainerParser.extractParasolid(buf);
    if (!result) continue;
    const psBuf = result.data;
    
    const entities = extractAllEntities(psBuf);
    
    // Count float lengths per type
    const type1E_counts = {}; // 0x1E = CURVE
    const type1F_counts = {}; // 0x1F = SURFACE
    
    const type1E_entities = [];
    const type1F_entities = [];
    
    for (const ent of entities) {
        const geom = readGeomFloats(ent.data);
        if (!geom) continue;
        
        if (ent.type === 0x1E) {
            const key = geom.floats.length;
            type1E_counts[key] = (type1E_counts[key] || 0) + 1;
            type1E_entities.push({ ...ent, floats: geom.floats, marker: geom.marker });
        } else if (ent.type === 0x1F) {
            const key = geom.floats.length;
            type1F_counts[key] = (type1F_counts[key] || 0) + 1;
            type1F_entities.push({ ...ent, floats: geom.floats, marker: geom.marker });
        }
    }
    
    const shortName = fname.replace(/.*nist_/, '').replace(/_sw1802.*/, '');
    console.log(`${shortName}:`);
    console.log(`  0x1E (CURVE):   ${JSON.stringify(type1E_counts)}  (total: ${type1E_entities.length})`);
    console.log(`  0x1F (SURFACE): ${JSON.stringify(type1F_counts)}  (total: ${type1F_entities.length})`);
    
    // For CTC_01, show detailed analysis of 0x1F 7-float entities
    if (fname.includes('ctc_01')) {
        console.log('\n  --- CTC_01 detailed 0x1F analysis ---');
        
        // Show float counts
        for (const ent of type1F_entities) {
            const f = ent.floats;
            if (f.length === 7 || f.length === 8) {
                const nx = f[3], ny = f[4], nz = f[5];
                const mag = Math.sqrt(nx*nx + ny*ny + nz*nz);
                console.log(`  id=${ent.id} ${f.length}f: origin=(${(f[0]*1000).toFixed(1)}, ${(f[1]*1000).toFixed(1)}, ${(f[2]*1000).toFixed(1)})mm  dir=(${nx.toFixed(4)}, ${ny.toFixed(4)}, ${nz.toFixed(4)}) |dir|=${mag.toFixed(4)} marker=${ent.marker === 0x2b ? '+' : '-'}`);
            } else if (f.length >= 11) {
                const radius = f[9] * 1000;
                const semiAngle = f[10];
                const surfType = Math.abs(semiAngle) < 1e-6 ? 'CYL' : 'CONE';
                console.log(`  id=${ent.id} ${f.length}f: ${surfType} r=${radius.toFixed(2)}mm semiAngle=${semiAngle.toFixed(4)} marker=${ent.marker === 0x2b ? '+' : '-'}`);
            } else {
                console.log(`  id=${ent.id} ${f.length}f: other  marker=${ent.marker === 0x2b ? '+' : '-'}`);
            }
        }
        
        // Compare 0x1E 7-float directions with 0x1F 7-float directions
        const dirs1E = type1E_entities.filter(e => e.floats.length === 7 || e.floats.length === 8)
            .map(e => ({ x: e.floats[3], y: e.floats[4], z: e.floats[5] }));
        const dirs1F = type1F_entities.filter(e => e.floats.length === 7 || e.floats.length === 8)
            .map(e => ({ x: e.floats[3], y: e.floats[4], z: e.floats[5] }));
        
        // Get unique directions for each
        function uniqueDirs(dirs) {
            const unique = [];
            for (const d of dirs) {
                const mag = Math.sqrt(d.x*d.x + d.y*d.y + d.z*d.z);
                const n = { x: d.x/mag, y: d.y/mag, z: d.z/mag };
                let isDup = false;
                for (const u of unique) {
                    const dot = Math.abs(u.x*n.x + u.y*n.y + u.z*n.z);
                    if (dot > 0.999) { isDup = true; break; }
                }
                if (!isDup) unique.push(n);
            }
            return unique;
        }
        
        const uniqu1E = uniqueDirs(dirs1E);
        const uniqu1F = uniqueDirs(dirs1F);
        console.log(`\n  Unique 7/8-float directions: 0x1E has ${uniqu1E.length}, 0x1F has ${uniqu1F.length}`);
        console.log('  0x1F unique directions:');
        for (const d of uniqu1F) {
            console.log(`    (${d.x.toFixed(4)}, ${d.y.toFixed(4)}, ${d.z.toFixed(4)})`);
        }
    }
    
    console.log('');
}
