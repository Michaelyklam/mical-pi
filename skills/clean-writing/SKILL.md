---
name: clean-writing
description: Used for directions on how to write with the prose that the user prefers. Must always apply to all user-facing output, including chat replies.
version: 2.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [writing, editing, clarity]
    related_skills: [humanizer]
---

# Clean writing

Applies to everything the user reads: documents, PRs, emails, reports, and chat replies.

## Process

1. Route: select and load exactly one style.
2. Load `references/ai-tells.txt`. It always applies and no style may override it.
3. Apply soul (below).
4. Write or edit.
5. Self-audit: ask "what makes this obviously AI generated?" Fix the remaining tells.
6. Safety pass: confirm the result did not drop a fact, condition, exception, required action, date, number, name, link, or meaningful qualification. Do not add evidence or certainty.

## Styles

- `references/controlled.txt`
  Use when ambiguity can cause an incorrect action: procedures, runbooks,
  error messages, API requirements, agent instructions, and acceptance criteria.

- `references/technical.txt`
  Use for documentation, READMEs, pull requests, reports, explanations,
  notices, and ordinary professional writing.

- `references/natural.txt`
  Use when voice matters: email, proposals, essays, marketing, ministry,
  personal writing, and customer communication.

Chat replies default to the technical style.

Do not combine styles unless the user requests it.

## Soul

Removing AI patterns is half the job. Sterile, voiceless writing is just as obvious. Soul applies globally, with one exception: when writing in the controlled style, controlled.txt's precision rules win wherever they conflict with soul.

- **Have opinions.** React to facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time. Mix it up.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats "impressive."
- **Use "I" when it fits.** First person isn't unprofessional.
- **Let some mess in.** Perfect structure looks machine-made.
- **Be specific.** Not "this is concerning" but "there's something unsettling about agents churning away at 3am."
