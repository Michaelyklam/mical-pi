---
name: clean-writing
description: Used for directions on how to write with the prose that the user prefers. Use this for all user-facing output.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [writing, editing, clarity]
    related_skills: [humanizer]
---

# Clean writing

Select and load exactly one style:

- `references/controlled.txt`
  Use when ambiguity can cause an incorrect action: procedures, runbooks,
  error messages, API requirements, agent instructions, and acceptance criteria.

- `references/technical.txt`
  Use for documentation, READMEs, pull requests, reports, explanations,
  notices, and ordinary professional writing.

- `references/natural.txt`
  Use when voice matters: email, proposals, essays, marketing, ministry,
  personal writing, and customer communication.

Do not combine styles unless the user requests it.

Preserve the original facts, intent, uncertainty, obligations, dates, numbers,
names, and links. Do not add evidence or certainty.

After editing, confirm that the rewrite did not remove a condition, exception,
required action, or meaningful qualification.
