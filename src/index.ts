/**
 * index.ts – public API surface for the open-sld-to-step library.
 *
 * Re-exports the key classes and types that consumers need.
 */

// Container parsers
export {
    OleContainerParser,
    OLE2_SIGNATURE,
    PARASOLID_STREAM_NAMES,
} from './parser/OleContainerParser.js';
export type {
    OleDirectoryEntry,
    OleStreamResult,
} from './parser/OleContainerParser.js';

export {
    Sw3DStorageParser,
    SW3D_SECTION_MARKER,
    SW3D_HEADER_SIZE,
    isParasolidBuffer,
    PARASOLID_MAGIC_SIGNATURES,
} from './parser/Sw3DStorageParser.js';
export type {
    Sw3DSection,
    Sw3DParasolidResult,
} from './parser/Sw3DStorageParser.js';

export {
    SldprtContainerParser,
} from './parser/SldprtContainerParser.js';
export type {
    ContainerFormat,
    ParasolidExtractResult,
} from './parser/SldprtContainerParser.js';

// Parasolid parser
export {
    ParasolidParser,
} from './parser/ParasolidParser.js';
export type {
    PsTransmitHeader,
    PsEntityCensus,
} from './parser/ParasolidParser.js';

// STEP mapper
export {
    ParasolidToStepMapper,
} from './step/ParasolidToStepMapper.js';
export type {
    PsModel,
    PsBody,
    PsShell,
    PsFace,
    PsLoop,
    PsEdge,
    PsVertex,
    PsCurve,
    PsSurface,
    PsPoint,
    PsDirection,
    StepEntity,
} from './step/ParasolidToStepMapper.js';

// End-to-end conversion
export {
    convertSldprtToStep,
} from './step/convertSldprtToStep.js';
export type {
    ConversionResult,
} from './step/convertSldprtToStep.js';
