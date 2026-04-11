/**
 * investigate34.mjs — Validate parser surface extraction and STEP output
 *
 * All observations derived from publicly available NIST MBE PMI test files
 * (U.S. Government works, public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SldprtContainerParser } from '../dist/parser/SldprtContainerParser.js';
import { ParasolidParser } from '../dist/parser/ParasolidParser.js';
import { ParasolidToStepMapper } from '../dist/step/ParasolidToStepMapper.js';

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const files = fs.readdirSync(NIST_DIR).filter(f => f.endsWith('.SLDPRT')).slice(0, 3);

for (const file of files) {
    console.log(`\n=== ${file} ===`);
    const buf = fs.readFileSync(path.join(NIST_DIR, file));
    const result = SldprtContainerParser.extractParasolid(buf);
    if (!result) { console.log('  No Parasolid data'); continue; }
    const psBuf = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data);

    const parser = new ParasolidParser(psBuf);
    const model = parser.parse();

    console.log(`  Vertices:  ${model.vertices.length}`);
    console.log(`  Surfaces:  ${model.surfaces.length}`);
    console.log(`  Faces:     ${model.faces.length}`);
    console.log(`  Loops:     ${model.loops.length}`);
    console.log(`  Shells:    ${model.shells.length}`);
    console.log(`  Bodies:    ${model.bodies.length}`);

    // Classify surfaces
    const byType = {};
    for (const s of model.surfaces) {
        byType[s.surfaceType] = (byType[s.surfaceType] || 0) + 1;
    }
    console.log(`  Surface types: ${JSON.stringify(byType)}`);

    // Generate STEP and check for key entities
    const mapper = new ParasolidToStepMapper();
    const entities = mapper.mapModel(model);
    const stepStr = ParasolidToStepMapper.toStepFile(entities);

    const advFaces = (stepStr.match(/ADVANCED_FACE/g) || []).length;
    const planes = (stepStr.match(/PLANE\(/g) || []).length;
    const cylinders = (stepStr.match(/CYLINDRICAL_SURFACE/g) || []).length;
    const cones = (stepStr.match(/CONICAL_SURFACE/g) || []).length;
    const breps = (stepStr.match(/MANIFOLD_SOLID_BREP/g) || []).length;
    const shells = (stepStr.match(/OPEN_SHELL/g) || []).length;

    console.log(`  STEP entities: ${entities.length}`);
    console.log(`  ADVANCED_FACE: ${advFaces}, PLANE: ${planes}, CYLINDRICAL: ${cylinders}, CONICAL: ${cones}`);
    console.log(`  MANIFOLD_SOLID_BREP: ${breps}, OPEN_SHELL: ${shells}`);
}
