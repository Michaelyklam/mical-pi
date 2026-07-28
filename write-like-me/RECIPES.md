# Recipes / cooking instructions

Source: `Documents/Michael's Thoughts/Recipes` (~49 files — this is the canonical, rewritten set). The older top-level `/Recipes` folder is raw, unedited paste-ins (typos, no template, casual asides) — treat it as superseded, not as a style source.

## Structure
One consistent template, in this order:
1. YAML frontmatter with a `servings`/`batches` variable
2. H1 title
3. Bold metadata block: **Source**, **Yield**, **Time**, an `INPUT[...]` field
4. `---`
5. `## About` — 2–3 sentence description, often with a bolded **Key Technique:** callout
6. `---`
7. `## Ingredients` — checkbox list, sub-grouped with `###` when the dish has multiple components (e.g. "Toffee" / "Brown Butter" / "Cookie Dough")
8. `---`
9. `## Instructions` — numbered `###` phase headers ("1. Mix", "2. First Rise"), each with a numbered sub-list of steps
10. Optional `## Tips`, `## Storage`, `## Serving Suggestions`
11. `---`
12. `**Tags:** #recipe #cuisine #protein #category` on the last line

Measurements are metric (g/ml/°C). Quantities use a `VIEW[{servings} * N]` scaling formula rather than static numbers — every recipe scales. No tables. No wikilinks to other notes — recipes are self-contained.

## Sentence & paragraph style
- Steps are short imperative commands — verb + object + condition ("Dissolve salt in the water," "Fold sauce mixture into warm rice until evenly coated"). Rarely more than one clause.
- Reasoning/explanation is pulled OUT of the step and into a separate bolded sub-bullet (`- **Tip:**`) or a **Key Technique** line — don't weave explanation into the imperative sentence itself.
- The `## About` section is the only place with fuller prose, and it's still terse (2–3 sentences).

## Formatting habits
- Numbered lists for both ingredients (as checkboxes) and steps; prose is avoided in Instructions almost entirely.
- Bold only for structural labels (**Source:**, **Time:**, **Tip:**, **Key Technique:**) or a genuine caveat — never random emphasis.
- Times/temps are plain text (163°C, 6 minutes 30 seconds), not bolded.
- Personal annotations are always an indented sub-bullet directly under the relevant step: `- **Tip:** ...` or `- **Important:** ...`.

## Tone & vocabulary
- Technical and efficient — closer to a lab protocol than a food blog. No filler, no "you'll love this."
- Personal commentary is sparse and purposeful: almost always a troubleshooting warning (what goes wrong if you skip a step), not flavor praise.
- Recurring phrasing: "adjust to taste," "until fragrant," "don't skip," "serve immediately," and consequence pairs ("too hot and X, too cool and Y").

## Verbatim calibration
- "Remove from heat, let cool 30 seconds — **Tip:** This is the most important step — prevents scrambled eggs" (Carbonara)
- "**Key Technique:** Browned butter and a rest period for the egg-espresso mixture both add significant flavor depth — don't skip either." (Brown Butter Chocolate Chip Cookies)
- "Never rush the cooling — let it come down gradually in the oven with the door ajar." (New York Cheesecake)

## Checklist
- [ ] Follows the fixed section order (About → Ingredients → Instructions → Tips/Storage → Tags)
- [ ] Steps are imperative one-clause commands, not narrated prose
- [ ] Any reasoning/warning lives in a `**Tip:**`/`**Important:**` sub-bullet, not inline in the step
- [ ] Metric units, scalable quantities
- [ ] No flavor-praise filler — commentary is functional (what breaks if you skip this)
