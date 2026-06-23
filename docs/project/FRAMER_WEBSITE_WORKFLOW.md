---
description: "Working reference for Rebel Framer and website tasks - design intent, preview/publish boundaries, inspiration translation, and product-evidence standards."
last_updated: "2026-06-15"
---

# Framer Website Working Reference

Use this before changing Rebel website or Framer surfaces, especially the Rebel 2 homepage bundle in `marketing-assets/source/rebel2-homepage-bundle/`.

This doc captures the recurring corrections from recent Framer/website sessions: treat Framer work as a product-design workflow, not just a code edit; preview before publishing when asked; translate references into Rebel's system instead of copying them; and use real, filled Rebel product evidence.

## See also

- [`marketing-assets/source/rebel2-homepage-bundle/README.md`](../../marketing-assets/source/rebel2-homepage-bundle/README.md) - rebuild, verify, gist, and Framer source-pin pipeline for the Rebel 2 page.
- [`marketing-assets/references/full-window-collage-direction.md`](../../marketing-assets/references/full-window-collage-direction.md) - structural rules for website hero and product-collage references.
- [`marketing-assets/references/craft-pricing-paywall-direction.md`](../../marketing-assets/references/craft-pricing-paywall-direction.md) - pricing/paywall reference translation notes.
- [BRAND_VOICE](./BRAND_VOICE.md) - voice and product philosophy for public-facing copy.
- [UI_OVERVIEW](./UI_OVERVIEW.md) - app UI system context when website assets reuse product patterns.

## First Question

Start every Framer task by identifying the actual requested state:

- **Design direction**: the user wants judgment, structure, copy, or a proposed approach.
- **Local bundle edit**: the user wants repo source changed and local previews/screenshots.
- **Live Framer update**: the user wants the public Framer surface changed.

Do not collapse these into one vague "done". In status updates and final summaries, name the state precisely: `local only`, `preview generated`, `gist updated`, `Framer source pin updated`, or `live verified`.

## Preview And Publish Rules

- If the user says anything like "show me before you update Framer", stop at local preview. Provide screenshots or the generated preview artifact, then wait for approval before publishing.
- Treat "update Framer" as the full publish path: rebuild the bundle, verify locally, publish the gist/raw revision if the page uses one, update the Framer code component/source pin, then verify the live page.
- A local source edit is not a Framer update. A gist edit is not necessarily a Framer update. A Framer source-pin update is not complete until the live page has been checked.
- Keep the repo source reproducible. If a live Framer page changes, the source files and notes that regenerate it should change too.

## Design Intent Before Production

Before making a new section or visual asset, state the strategic job:

- What should this section make a non-technical buyer believe or understand?
- Which audience or persona is it serving?
- How does it advance the homepage story from promise, to proof, to trust, to action?
- What is the primary scan order?

This avoids producing decorative assets that look polished but do not explain Rebel.

## Translating References

References are structure, not source material.

Borrow:

- Layout order and scan rhythm.
- Hierarchy, density, spacing, transparency, motion, and z-order.
- Composition grammar: fan-outs, browser frames, proof strips, card stacks, overlays, and atmospheric depth.
- The reason a reference works, such as "pricing as a layered scene" or "hero proof after CTA".

Do not borrow:

- Third-party screenshots, logos, UI panels, copy, exact colors, cursor art, characters, paper shapes, or decorative assets.
- Off-system visual choices just because they appear in the reference.
- Literal scrapbook or SaaS-template effects unless they have been translated into Rebel's own material language.

## Rebel System Guardrails

Preserve Rebel's website system unless the user explicitly asks to change it:

- Use Rebel's current palette, typeface, spacing, radius, CTA hierarchy, and dark/light contrast rules.
- Keep Framer marketing typography lighter than the app UI: display headings should usually sit around `600`-`700`, cards/CTAs around `600`-`700`, and avoid blanket `800`/`900` weights unless a specific local label needs it.
- Buttons and CTAs use rounded-rectangle corners, not pill geometry. Reserve fully round shapes for dots, checkmarks, avatars, or tiny status/icon markers.
- Treat the Rebel 2 cloudy light-blue/lavender background with subtle dots as a reusable page atmosphere for light proof/commercial sections. Reuse it through a shared scoped recipe, not one-off gradients on each section.
- Avoid yellow/cream, black primary CTAs, generic system fonts, random borders, fake paper cards, and unsupported decorative elements unless there is an explicit Rebel-system rationale.
- `Download Rebel` should usually read as the quieter/self-serve CTA when paired with a stronger commercial/team CTA. Do not let secondary CTAs overpower the main action.
- If the user says "same style", assume they mean treatment, hierarchy, component logic, and visual system, not only similar copy.
- For local Framer/marketing organisms, keep styles scoped to the bundle or section. Do not promote one-off website treatments into shared app UI primitives.

## Product Evidence Rules

Website visuals should prove that Rebel is real, useful, and controlled.

- Use real Rebel screenshots, real Rebel React component captures, or approved Rebel-owned assets.
- Prefer filled demo/authenticated states over empty onboarding or unauthenticated public pages.
- If a screenshot needs logged-in product data, use the appropriate app/browser capture path instead of settling for an empty state.
- Never invent fake product UI, unsupported connector logos, provider/model lists, customer logos, or feature claims.
- Inspect exported images at final display size for tiny text, clipping, low contrast, dark-on-dark flattening, stale copy, and pixelation.

## Working Checklist

Before editing:

- Confirm whether the task is design direction, local preview, or live publish.
- Read the relevant bundle README and reference notes.
- State the communication job and intended scan order.
- Identify what existing Rebel assets/components can be reused.

Before showing a preview:

- Verify Rebel palette, typography, CTA hierarchy, and spacing.
- Check that reference influence is structural only.
- Confirm all product visuals are real, filled, and current enough for the brief.
- Open the generated preview or export and inspect it at the intended size.

Before publishing to Framer:

- Rebuild and run the local verifier.
- Publish/update the required source artifact.
- Update the Framer code component/source pin when the pipeline requires it.
- Verify the live page and report exactly what changed.
