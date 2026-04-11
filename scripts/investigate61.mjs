#!/usr/bin/env node
/**
 * investigate61.mjs — Check which planes are removed by 2D spread validation
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const files = fs.readdirSync(NIST_DIR).filter(f => f.endsWith('.SLDPRT')).sort();

const PS_TO_MM = 1000;

for (const file of files) {
    const buf = fs.readFileSync(path.join(NIST_DIR, file));
    const result = SldprtContainerParser.extractParasolid(buf);
    const parser = new ParasolidParser(result.data);
    
    const coords = parser.extractCoordinates();
    const verts = coords.map(c => ({ x: c.x*PS_TO_MM, y: c.y*PS_TO_MM, z: c.z*PS_TO_MM }));
    
    // Get raw extracted surfaces (before validation)
    const rawSurfaces = parser.extractSurfaces();
    const rawPlanes = rawSurfaces.filter(s => s.surfaceType === 'plane');
    
    // Count how many pass the old check (>=3 coplanar verts)
    let passOld = 0;
    let passNew = 0;
    let removedBySpread = 0;
    
    for (const surf of rawPlanes) {
        const p = surf.params;
        const coplanarVerts = [];
        for (const v of verts) {
            const dx = v.x - p.origin.x, dy = v.y - p.origin.y, dz = v.z - p.origin.z;
            const dist = Math.abs(dx * p.normal.x + dy * p.normal.y + dz * p.normal.z);
            if (dist < 0.5) coplanarVerts.push(v);
            if (coplanarVerts.length >= 20) break;
        }
        
        if (coplanarVerts.length >= 3) {
            passOld++;
            
            // Check 2D spread
            const nz = Math.abs(p.normal.z);
            const ny = Math.abs(p.normal.y);
            const nx = Math.abs(p.normal.x);
            // Simple planeBasis
            let ux, uy, uz, vx, vy, vz;
            if (nz < 0.9) {
                ux = p.normal.y * 1 - p.normal.z * 0;
                uy = p.normal.z * 0 - p.normal.x * 1;
                uz = p.normal.x * 0 - p.normal.y * 0;
            } else {
                ux = p.normal.y * 0 - p.normal.z * 0;
                uy = p.normal.z * 1 - p.normal.x * 0;
                uz = p.normal.x * 0 - p.normal.y * 1;
            }
            const uLen = Math.sqrt(ux*ux+uy*uy+uz*uz);
            ux /= uLen; uy /= uLen; uz /= uLen;
            vx = p.normal.y*uz - p.normal.z*uy;
            vy = p.normal.z*ux - p.normal.x*uz;
            vz = p.normal.x*uy - p.normal.y*ux;
            
            let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
            for (const v of coplanarVerts) {
                const pu = v.x*ux + v.y*uy + v.z*uz;
                const pv = v.x*vx + v.y*vy + v.z*vz;
                if (pu < uMin) uMin = pu;
                if (pu > uMax) uMax = pu;
                if (pv < vMin) vMin = pv;
                if (pv > vMax) vMax = pv;
            }
            
            if ((uMax - uMin) >= 1.0 && (vMax - vMin) >= 1.0) {
                passNew++;
            } else {
                removedBySpread++;
            }
        }
    }
    
    const name = file.replace('nist_', '').replace('_sw1802.SLDPRT', '');
    console.log(`${name.padEnd(25)} raw=${String(rawPlanes.length).padStart(3)}  oldCheck=${String(passOld).padStart(3)}  newCheck=${String(passNew).padStart(3)}  removedBySpread=${removedBySpread}`);
}
