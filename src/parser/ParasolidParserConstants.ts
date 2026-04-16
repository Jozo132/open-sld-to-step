import { Buffer } from 'node:buffer';

export const RECORD_MARKER_P = 0x70; // '=p'
export const RECORD_MARKER_Q = 0x71; // '=q'
export const RECORD_PREFIX = 0x3d; // '='

export const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
export const SENTINEL_8 = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);

export const ENTITY_POINT = 0x1d;
export const ENTITY_COEDGE = 0x12;
export const ENTITY_EDGE = 0x10;
export const ENTITY_FACE = 0x0f;
export const ENTITY_SURFACE = 0x1e;
export const ENTITY_BSPLINE = 0x1f;
export const ENTITY_GEOM_AUX = 0x26;
export const ENTITY_GEOM_CHAIN = 0x86;
export const ENTITY_SHELL = 0x11;
export const ENTITY_LOOP = 0x13;
export const ENTITY_ATTRIB = 0x20;

export const SCHEMA_FIELD_TYPE_BYTES = new Set<number>([
    0x41,
    0x43,
    0x44,
    0x46,
    0x49,
    0x4a,
    0x51,
    0x52,
    0x64,
]);

export const NAMED_CLASS_TYPE_BYTES = new Map<number, 'P' | 'O' | 'Q'>([
    [0x50, 'P'],
    [0x4f, 'O'],
    [0x51, 'Q'],
]);

export const POINT_COORD_OFFSET = 16;
export const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
export const PS_TO_MM = 1000;