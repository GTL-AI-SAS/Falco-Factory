# FALCO — Option 04 asset pack

This package contains the final FALCO identity direction based on the fourth/final identity-system board, using the **Vector Beak** emblem direction.

## Contents

- `01_SVG/` — editable SVG logo assets (paths for the emblem; wordmark text remains editable, with the final C in the mint accent).
- `02_PNG/` — transparent logo exports, app icons, favicon sizes, and variant exports; all wordmark PNGs include the mint C accent.
- `03_Brand_Guide/` — quick brand specification and the visual reference board.

## Quick start

- Website logo: `01_SVG/Primary/falco-primary-horizontal-dark.svg`
- Light-background logo: `01_SVG/Primary/falco-primary-horizontal-light.svg`
- App icon: `01_SVG/Icons/falco-app-icon.svg`
- Favicon: `02_PNG/Icons/favicon.ico`
- Apple touch icon: `02_PNG/Icons/apple-touch-icon-180.png`

## Wordmark color rule

The final **C** in FALCO is always Mint / turquoise (`#68E2C3`), matching the emblem ring and the cinematic animation. **FAL** and **O** retain the foreground color of each logo variant. Emblem-only icons and favicon assets do not contain a wordmark and remain unchanged.

## Technical note

The emblem is drawn from editable SVG paths. Wordmark text is editable SVG text using Inter/Arial fallback; install Inter for the closest match. PNG exports mirror the SVG compositions and retain their original dimensions. The existing `Monochrome/` folder path is retained for compatibility; its emblem-only assets remain monochrome, while the black and white wordmark lockups include the Mint **C** accent. The geometry is a vector reconstruction of the selected concept board, not a raster embedded in an SVG.
