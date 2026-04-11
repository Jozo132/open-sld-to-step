#!/usr/bin/env node
/**
 * investigate55.mjs — Cone surface extraction analysis
 * Compare our extracted cones against reference STEP cones.
 * NIST test files are US Government works (public domain).
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const REF_CTC = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');
const REF_FTC = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'FTC Definitions');

function getRefPath(base) {
    for (const dir of [REF_CTC, REF_FTC]) {
        const p = path.join(dir, base + '.stp');
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function extractRefCones(stepText) {
    const entities = new Map();
    const re = /#(\d+)\s*=\s*(\S+?)\s*\((.+)\)\s*;/g;
    let m;
    while ((m = re.exec(stepText)) !== null) {
        entities.set(parseInt(m[1]), { type: m[2], args: m[3] });
    }
    
    const cones = [];
    for (const [id, e] of entities) {
        if (e.type !== 'CONICAL_SURFACE') continue;
        // CONICAL_SURFACE('', #axis, radius, halfAngle)
        const refs = [...e.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
        const nums = [...e.args.matchAll(/[\d.E+\-]+/g)].map(m => parseFloat(m[0])).filter(n => isFinite(n));
        // Last two numbers are radius and halfAngle
        const radius = nums[nums.length - 2];
        const halfAngle = nums[nums.length - 1];
        
        // Resolve axis
        const axisEnt = entities.get(refs[0]);
        if (!axisEnt) continue;
        const axRefs = [...axisEnt.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
        
        const ptEnt = entities.get(axRefs[0]);
        const dirEnt = entities.get(axRefs[1]);
        if (!ptEnt || !dirEnt) continue;
        
        const ptNums = [...ptEnt.args.matchAll(/-?[\d.E+\-]+/g)].map(m => parseFloat(m[0])).filter(n => isFinite(n));
        const dirNums = [...dirEnt.args.matchAll(/-?[\d.E+\-]+/g)].map(m => parseFloat(m[0])).filter(n => isFinite(n));
        
        cones.push({
            id,
            origin: ptNums.slice(-3),
            axis: dirNums.slice(-3),
            radius,
            halfAngle,
        });
    }
    return cones;
}

// Test with CTC_02 (158 reference cones) and CTC_04 (64 cones)
for (const base of ['nist_ctc_02_asme1_rc', 'nist_ctc_04_asme1_rd', 'nist_ctc_01_asme1_rd']) {
    const sldprtPath = path.join(NIST_DIR, base + '_sw1802.SLDPRT');
    if (!fs.existsSync(sldprtPath)) { console.log(`${base}: no SLDPRT`); continue; }
    
    const buf = fs.readFileSync(sldprtPath);
    const result = SldprtContainerParser.extractParasolid(buf);
    const parser = new ParasolidParser(result.data);
    const model = parser.parse();
    
    const ourCones = model.surfaces.filter(s => s.surfaceType === 'cone');
    const ourCyls = model.surfaces.filter(s => s.surfaceType === 'cylinder');
    
    console.log(`\n=== ${base} ===`);
    console.log(`Our surfaces: ${model.surfaces.length} (planes=${model.surfaces.filter(s=>s.surfaceType==='plane').length}, cyls=${ourCyls.length}, cones=${ourCones.length})`);
    console.log(`Our faces: ${model.faces.length}`);
    
    for (const c of ourCones.slice(0, 10)) {
        const p = c.params;
        console.log(`  Cone: r=${p.radius?.toFixed(2)} halfAngle=${p.halfAngle?.toFixed(4)} origin=(${p.origin?.x?.toFixed(1)},${p.origin?.y?.toFixed(1)},${p.origin?.z?.toFixed(1)}) axis=(${p.axis?.x?.toFixed(3)},${p.axis?.y?.toFixed(3)},${p.axis?.z?.toFixed(3)})`);
    }
    
    // Check cone vertex associations
    for (const c of ourCones.slice(0, 5)) {
        const faceForCone = model.faces.find(f => f.surface === c.id);
        console.log(`  Cone id=${c.id}: face=${faceForCone ? 'YES' : 'NO'}`);
    }
    
    // Reference cones
    const refPath = getRefPath(base);
    if (refPath) {
        const refText = fs.readFileSync(refPath, 'utf8');
        const refCones = extractRefCones(refText);
        console.log(`Reference cones: ${refCones.length}`);
        for (const rc of refCones.slice(0, 10)) {
            console.log(`  RefCone: r=${rc.radius?.toFixed(2)} halfAngle=${rc.halfAngle?.toFixed(4)} origin=(${rc.origin?.map(v=>v.toFixed(1)).join(',')}) axis=(${rc.axis?.map(v=>v.toFixed(3)).join(',')})`);
        }
    }
}
