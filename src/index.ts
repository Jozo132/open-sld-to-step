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
