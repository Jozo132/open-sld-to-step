# Legal Notice

## Clean-Room Implementation

This project — **open-sld-to-step** — is a **clean-room implementation**
developed exclusively for **interoperability purposes**.

All container-parsing and geometry-translation code has been written from
scratch by studying:

- The publicly available **[MS-CFB] Compound File Binary File Format**
  specification published by Microsoft.
- The **ISO 10303** (STEP) family of standards for product-data exchange.
- Public-domain technical references describing the Parasolid BRep model
  topology (body → lump → shell → face → loop → edge → vertex).
- Observable byte-level structure of publicly available, non-restricted CAD
  sample files (specifically the **NIST MBE PMI Validation and Conformance
  Testing** data sets, which are U.S. Government works in the public domain).

**No proprietary source code, header files, SDKs, or API documentation from
Dassault Systèmes, Siemens, or any other vendor has been used, referenced,
or reverse-engineered during the development of this project.**

The sole intent of this project is to enable standards-based data exchange
between CAD systems by converting geometry streams into ISO 10303 STEP files,
in accordance with the principles of software interoperability.

## Trademarks

- **SolidWorks®** is a registered trademark of **Dassault Systèmes SolidWorks
  Corporation**.
- **Parasolid®** is a registered trademark of **Siemens Industry Software
  Inc.**
- **STEP** (Standard for the Exchange of Product model data) is defined by
  **ISO 10303** and is maintained by the International Organization for
  Standardization (ISO).

All other trademarks and trade names mentioned in this repository are the
property of their respective owners and are used here solely for
identification purposes.

## Licence

This project is released under the **Apache License 2.0** — see `LICENSE`
for the full text.

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED. THE AUTHORS AND CONTRIBUTORS MAKE NO REPRESENTATIONS REGARDING THE
ACCURACY OR COMPLETENESS OF ANY GEOMETRY CONVERSION PERFORMED BY THIS
SOFTWARE. USE AT YOUR OWN RISK.
