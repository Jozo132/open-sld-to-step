/**
 * convertSldprtToStep.ts
 *
 * End-to-end conversion function: reads a SolidWorks .SLDPRT buffer,
 * extracts the embedded Parasolid BRep stream, parses the topology,
 * and emits a valid ISO 10303-21 (STEP AP214) file.
 */

import { SldprtContainerParser } from '../parser/SldprtContainerParser.js';
import { ParasolidParser } from '../parser/ParasolidParser.js';
import { ParasolidToStepMapper } from './ParasolidToStepMapper.js';
import type { PsModel, StepEntity } from './ParasolidToStepMapper.js';

/** Result of the end-to-end SLDPRT → STEP conversion. */
export interface ConversionResult {
    /** The generated ISO 10303-21 STEP file content. */
    step: string;
    /** The intermediate PsModel (for inspection / debugging). */
    model: PsModel;
    /** The flat list of STEP entities (for programmatic access). */
    entities: StepEntity[];
    /** Container format that was detected ('ole2' | 'sw3d'). */
    containerFormat: string;
    /** Size in bytes of the extracted Parasolid stream. */
    parasolidSize: number;
    /** Modeller version from the Parasolid header, if available. */
    modellerVersion: number;
}

/**
 * Convert a SolidWorks .SLDPRT file buffer to an ISO 10303-21 STEP string.
 *
 * Pipeline:
 *  1. Detect container format (OLE2 / CFB  or  SW 3D Storage v4)
 *  2. Extract the Parasolid BRep stream (with double-decompression if needed)
 *  3. Parse the Parasolid binary transmit format into a PsModel
 *  4. Map the PsModel to STEP AP214 entities
 *  5. Serialise to ISO 10303-21 text
 *
 * @param buf       Full contents of a .SLDPRT file.
 * @param fileName  Optional name for the STEP file header.
 * @returns         Conversion result, or `null` if no geometry was found.
 */
export function convertSldprtToStep(
    buf: Buffer,
    fileName = 'output.stp',
): ConversionResult | null {
    // Step 1–2: Extract Parasolid stream
    const extraction = SldprtContainerParser.extractParasolid(buf);
    if (!extraction) return null;

    // Step 3: Parse the Parasolid binary transmit format
    const parser = new ParasolidParser(extraction.data);
    const header = parser.parseHeader();
    const model = parser.parse();

    // Step 4: Map to STEP entities
    const mapper = new ParasolidToStepMapper();
    const entities = mapper.mapModel(model);

    // Step 5: Serialise
    const step = ParasolidToStepMapper.toStepFile(entities, fileName);

    return {
        step,
        model,
        entities,
        containerFormat: extraction.format,
        parasolidSize: extraction.data.length,
        modellerVersion: header?.modellerVersion ?? 0,
    };
}
