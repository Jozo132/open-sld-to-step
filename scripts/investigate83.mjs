#!/usr/bin/env node
/**
 * investigate83.mjs — Verify COEDGE loop chains by following next_coedge links.
 * 
 * FACE.data[18:20] → first COEDGE (for 132/175 faces)
 * COEDGE compact format: data[0:8] = [ref1, prev_coedge, next_coedge, vertex] + SENTINEL
 * Follow COEDGE.next to form loops. Count loop length per face.
 *
 * Also verify ACROSS MULTIPLE NIST files to ensure the format is consistent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');

function extractCompactEntities(buf) {
    const ents = new Map();
    const byPos = [];
    for (let i = 0; i < buf.length - 9; i++) {
        if (buf[i] !== 0x00) continue;
        const type = buf[i + 1];
        if (type < 0x0F || type > 0x20) continue;
        if (buf[i + 4] !== 0x00 || buf[i + 5] !== 0x00) continue;
        if (buf[i + 8] !== 0x00 || buf[i + 9] !== 0x01) continue;
        const id = buf.readUInt16BE(i + 2);
        if (id === 0 || id > 60000) continue;
        const e = { pos: i, type, id, dataStart: i + 10 };
        ents.set(id, e);
        byPos.push(e);
    }
    byPos.sort((a, b) => a.pos - b.pos);
    // Compute data lengths
    for (let i = 0; i < byPos.length; i++) {
        byPos[i].dataLen = (i + 1 < byPos.length) ? byPos[i + 1].pos - byPos[i].dataStart : buf.length - byPos[i].dataStart;
    }
    return { byId: ents, byPos };
}

function analyzeFile(filePath, fileName) {
    if (!fs.existsSync(filePath)) { console.log(`SKIP ${fileName}: not found`); return; }
    const buf = fs.readFileSync(filePath);
    const result = SldprtContainerParser.extractParasolid(buf);
    if (!result) { console.log(`SKIP ${fileName}: no PS data`); return; }
    const ps = result.data;
    
    const { byId, byPos } = extractCompactEntities(ps);
    
    const faces = [...byId.values()].filter(e => e.type === 0x0F);
    const coedges = [...byId.values()].filter(e => e.type === 0x12);
    const edges = [...byId.values()].filter(e => e.type === 0x10);
    const points = [...byId.values()].filter(e => e.type === 0x1D);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${fileName}: ${ps.length}B, ${faces.length} faces, ${coedges.length} coedges, ${edges.length} edges, ${points.length} points`);
    
    // Build COEDGE ref map: id → [ref1, prev, next, vertex]
    const coedgeRefs = new Map();
    for (const ce of coedges) {
        const data = ps.subarray(ce.dataStart, ce.dataStart + 8);
        if (data.length < 8) continue;
        const ref1 = data.readUInt16BE(0);     // unknown ref
        const prev = data.readUInt16BE(2);      // prev coedge
        const next = data.readUInt16BE(4);      // next coedge
        const vertex = data.readUInt16BE(6);    // vertex (POINT)
        coedgeRefs.set(ce.id, { ref1, prev, next, vertex });
    }
    
    // For each FACE, try to extract starting COEDGE from data field[9] (bytes 18-19)
    // Also try other fields if field[9] doesn't work
    
    let successfulChains = 0;
    let failedChains = 0;
    const loopLengths = [];
    
    for (const face of faces.slice(0, 30)) {
        const data = ps.subarray(face.dataStart, face.dataStart + Math.min(face.dataLen, 40));
        
        // Try field[9] (bytes 18-19) as starting COEDGE
        let startCoedge = null;
        for (const fieldIdx of [9, 7, 8, 0, 1]) {
            if (fieldIdx * 2 + 2 > data.length) continue;
            const ref = data.readUInt16BE(fieldIdx * 2);
            if (coedgeRefs.has(ref)) {
                startCoedge = ref;
                break;
            }
        }
        
        if (!startCoedge) {
            failedChains++;
            continue;
        }
        
        // Follow next_coedge chain
        let current = startCoedge;
        const visited = new Set();
        const chain = [];
        
        while (current && !visited.has(current) && chain.length < 100) {
            visited.add(current);
            const refs = coedgeRefs.get(current);
            if (!refs) break;
            chain.push({ coedge: current, vertex: refs.vertex, ref1: refs.ref1 });
            current = refs.next;
        }
        
        const looped = current === startCoedge;
        
        if (looped && chain.length >= 3) {
            successfulChains++;
            loopLengths.push(chain.length);
            
            if (face === faces[0] || face === faces[1]) {
                // Show details for first two faces
                const vertexCoords = chain.map(c => {
                    const vEnt = byId.get(c.vertex);
                    if (!vEnt || vEnt.type !== 0x1D) return null;
                    const vData = ps.subarray(vEnt.dataStart, vEnt.dataStart + 30);
                    if (vData.length < 30) return null;
                    const x = vData.readDoubleBE(6) * 1000;
                    const y = vData.readDoubleBE(14) * 1000;
                    const z = vData.readDoubleBE(22) * 1000;
                    return `(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`;
                }).filter(Boolean);
                
                console.log(`  FACE#${face.id}: loop of ${chain.length} coedges [${looped ? 'CLOSED' : 'OPEN'}]`);
                console.log(`    vertices: ${vertexCoords.join(' → ')}`);
                console.log(`    coedge refs: ${chain.map(c => `CE#${c.coedge}→V#${c.vertex}(ref1=${c.ref1})`).join(', ')}`);
            }
        } else {
            failedChains++;
            if (failedChains <= 3) {
                console.log(`  FACE#${face.id}: chain length ${chain.length}, looped=${looped}, start=${startCoedge}`);
            }
        }
    }
    
    console.log(`  Chain results: ${successfulChains} closed loops, ${failedChains} failed`);
    if (loopLengths.length > 0) {
        const avg = loopLengths.reduce((a, b) => a + b, 0) / loopLengths.length;
        console.log(`  Loop lengths: min=${Math.min(...loopLengths)} max=${Math.max(...loopLengths)} avg=${avg.toFixed(1)}`);
        
        // Distribution
        const dist = {};
        for (const l of loopLengths) { dist[l] = (dist[l] || 0) + 1; }
        console.log(`  Distribution: ${Object.entries(dist).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k}:${v}`).join(' ')}`);
    }
    
    // ─── Try ALL face fields for COEDGE reference ────────────────────────
    if (successfulChains < faces.length * 0.6) {
        console.log(`\n  Low success rate ${successfulChains}/${faces.length}. Trying all fields...`);
        for (let fieldIdx = 0; fieldIdx < 15; fieldIdx++) {
            let matches = 0;
            let closedLoops = 0;
            for (const face of faces) {
                const data = ps.subarray(face.dataStart, face.dataStart + 40);
                if (fieldIdx * 2 + 2 > data.length) continue;
                const ref = data.readUInt16BE(fieldIdx * 2);
                if (!coedgeRefs.has(ref)) continue;
                matches++;
                
                // Follow chain
                let current = ref;
                const visited = new Set();
                let chainLen = 0;
                while (current && !visited.has(current) && chainLen < 100) {
                    visited.add(current);
                    const refs = coedgeRefs.get(current);
                    if (!refs) break;
                    chainLen++;
                    current = refs.next;
                }
                if (current === ref && chainLen >= 3) closedLoops++;
            }
            if (matches > 10) {
                console.log(`  Field[${fieldIdx}]: ${matches} match coedge, ${closedLoops} closed loops`);
            }
        }
    }
}

// Analyze multiple NIST files
const files = [
    { name: 'CTC_01', file: 'nist_ctc_01_asme1_rd_sw1802.SLDPRT' },
    { name: 'CTC_03', file: 'nist_ctc_03_asme1_rc_sw1802.SLDPRT' },
    { name: 'FTC_11', file: 'nist_ftc_11_asme1_rb_sw1802.SLDPRT' },
    { name: 'FTC_08', file: 'nist_ftc_08_asme1_rc_sw1802.SLDPRT' },
];

for (const { name, file } of files) {
    analyzeFile(path.join(NIST_DIR, file), name);
}
