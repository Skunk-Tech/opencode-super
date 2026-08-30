---
name: ui-design
description: Use when creating or redesigning a component, section, page, or full UI inside an existing codebase, or when asked to restyle, polish, improve visual design, fix layout/spacing/typography, extract a color palette, add motion, or fix Arabic/RTL correctness. Triggers on "redesign", "restyle", "make it look better", "build this component/section/page", "pick colors/typography", "add animations", or RTL/Arabic layout work.
---

# UI Design — Production, Any Stack

## Overview

Produce UI work that belongs in the target codebase. Detect the stack, conform to its existing conventions, cover every interaction state, and pass the quality rubric before calling it done.

**Core principle:** Conform, don't compete. Adopt the project's active framework, design tokens, and class conventions — never introduce a parallel styling system.

## When to Use

- Creating a new component, section, or page in an existing codebase
- Redesigning or restyling an existing component/section/page
- Picking a color palette, pairing typography, choosing a design direction
- Adding or reviewing motion/interactions
- Fixing Arabic/RTL correctness or layout/spacing/typography problems
- Reviewing UI output against a quality bar before shipping

**Not this skill:** scaffolding a brand-new project from zero (use the matching track skill), or building a standalone zero-build prototype in a separate folder.

## Step 1 — Detect the Stack

Before producing output, identify the target stack from the files shown or named. If ambiguous, ask — never guess.

| Stack | Styling foundation | Component convention | Motion |
|---|---|---|---|
| React / Next.js | Tailwind v4/v3 or CSS Modules | Radix/shadcn + CVA + clsx + tailwind-merge | Framer Motion |
| PHP (Blade/Plates/views) | Tailwind or CSS custom properties | Semantic HTML5 partials | Alpine.js or CSS transitions |
| WordPress / classic CMS | Theme CSS / Gutenberg styles | Template parts / block markup | Native CSS keyframes / vanilla JS |
| Static HTML/CSS/JS | Semantic CSS / CSS variables | Modular component blocks | Vanilla JS / CSS transitions |

If the project uses a locked architecture (a specific framework convention already in place), that architecture wins. Supply the design decision, don't override the file/module contract.

## Step 2 — Conform to Existing Conventions

- Match existing naming, file layout, and styling approach (Tailwind classes if the project uses Tailwind, its CSS methodology if not).
- If `brand.json` exists at the project root, read its tokens and map them into the project's CSS variables or theme config. That is the single source of truth.
- Never inject a second, parallel CSS layer into a codebase that already has one.

## Step 3 — Cover All 8 Interaction States

Every interactive component must implement all of these, not just the default:

| State | Requirement |
|---|---|
| default | Clear affordance; visible it does something |
| hover | Subdued lift or contrast elevation; transition ≤ 150ms |
| active | Pressed micro-scale (~0.98) or inset depth |
| focus-visible | 2px offset focus ring for keyboard users |
| disabled | Reduced opacity (~0.5), `cursor: not-allowed`, pointer-events off |
| loading | Skeleton or accessible spinner; no layout shift |
| empty | Welcoming empty state + actionable call to action |
| error | Semantic danger state with an accessible error description |

## Step 4 — Pass the 6-Axis Rubric

Score each axis 0–10. Any axis below 6 means the deliverable is not finished.

- **Palette** — WCAG 2.1 AA contrast; no generic AI purple/pink gradients without a brand mandate.
- **Hierarchy & rhythm** — clear visual anchor; intentional whitespace on a 4px/8px baseline grid.
- **Execution** — full semantic HTML; no empty `<div>` soup or misplaced wrappers.
- **States** — all 8 above implemented.
- **RTL** — 100% logical CSS properties when direction matters (see below).
- **Variety** — distinct design-school character; not a default Bootstrap look.

## Step 5 — Arabic / RTL (when the content is Arabic or bilingual)

- Use logical CSS properties, not directional ones: `margin-inline-start` (not `margin-left`), `padding-inline-end` (not `padding-right`), `inset-inline-start` (not `left`), `text-align: start` (not `left`).
- Use logical corner radii (`border-start-start-radius`) for directional corners.
- Never apply negative `letter-spacing` on Arabic text — it breaks cursive glyph connections.
- Increase line-height by ~15–20% vs Latin to accommodate ascenders/descenders.
- Flip directional icons/arrows for RTL; don't leave them pointing the wrong way.

## Step 6 — Scope the Change

- A component redesign touches only that component's definition and its own usages — never neighbors.
- A section redesign touches only that section's markup — never global nav, footer, or unrelated sections.
- Scope creep is a failure, not thoroughness.

## Step 7 — Verify

Before calling the work finished, confirm against the deliverable:

- [ ] Stack detected and conventions matched (no parallel CSS system)
- [ ] Brand tokens mapped if `brand.json` is present
- [ ] All 8 states implemented
- [ ] Every rubric axis ≥ 6
- [ ] RTL correct if Arabic content is present
- [ ] Change scoped to what was asked
- [ ] Renders correctly at mobile breakpoints

## Common Mistakes

- Inventing a new color system or Tailwind layer instead of reusing the project's.
- Shipping only the default state and calling it done.
- Using `margin-left`/`left-*` when the content is RTL.
- Redesigning a component and accidentally touching its neighbors.
- Generic "AI purple gradient" look with no design-school intent.

## Related Skills

- **superpowers:brainstorming** — establish intent and design direction before building.
- **superpowers:test-driven-development** — verify UI changes with tests where feasible.
- **superpowers:verification-before-completion** — confirm UI work renders before claiming success.
