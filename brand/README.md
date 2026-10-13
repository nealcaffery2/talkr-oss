# Talkr brand

The source of truth for the product's identity. Everything in the apps is
derived from what is here; when the brand changes, change it here first.

## Files

| File | What it is |
|---|---|
| `talkr-brand-sheet.png` | The pack as supplied: primary logo, icon, black / grey / white versions, palette. |
| `talkr-logo.png` | Primary logo (red mark + charcoal wordmark) on white, 1254×1254. |
| `talkr-icon.png` | The mark alone on white, 1254×1254. Source for every favicon and app icon. |
| `talkr-mark.svg` | Vector mark, `currentColor`, bars cut out. Use for UI at any size; colour it red, charcoal, grey or white. |

Derived copies live where each app needs them and are regenerated from
`talkr-icon.png`: `apps/web/public/logo-mark.png`, `apps/web/app/icon.png`,
`apps/web/app/apple-icon.png`, `apps/extension/talkr-voice/public/icons/*.png`.
The wordmark used on the web account page is cut from `talkr-logo.png`
(`apps/web/public/logo-wordmark.png`).

## Palette

| Name | Hex | Where it goes |
|---|---|---|
| Talkr Red | `#FF233B` | The one interactive accent: primary buttons, active tabs, links, outbound bubbles, focus rings. |
| Charcoal Black | `#111111` | The rail, the call hero, dark surfaces (`--ink`). |
| Medium Grey | `#7A7A7A` | Secondary text. |
| Light Grey | `#D9D9D9` | Borders and dividers where a visible line is wanted. |
| White | `#FFFFFF` | Panels. |

Derived tints used in the apps: hover `#E6142E`, soft tint `#FFE9EC`,
light on dark `#FF6B7C`.

## Rules

- The mark keeps its tail at the bottom left; never mirror it.
- Red mark with charcoal wordmark on light; white version on charcoal; black
  or grey versions only where colour is unavailable.
- Red is for actions. Errors and the End call control use the semantic red
  (`--red`), which is a shade darker so it still reads as danger next to the brand.
