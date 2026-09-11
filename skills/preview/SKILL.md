---
name: preview
description: Publish browser-viewable HTML artifacts through Preview. Use when creating a visual artifact, mockup, report, diagram, interactive demo, or other generated files that the user should inspect in a browser.
compatibility: Linux with access to /home/michael/personal-website-data/preview and standard shell tools.
---

# Preview

Publish finished HTML artifacts at an unguessable URL on `michaelyklam.me`.

## Publish an artifact

1. Build the complete artifact in a temporary directory outside the Preview root.
2. Put its entry point at `index.html`.
3. Keep every asset inside that directory. Use relative URLs in HTML, CSS, and JavaScript.
4. Review the files before publication. Preview URLs provide obscurity, not authentication. The artifact must contain no credentials, API keys, tokens, private keys, passwords, confidential data, personal information, `.env` files, credential files, or local filesystem paths.
5. Run `scripts/publish-preview.sh <artifact-directory>`, resolving the script path relative to this skill directory.
6. Return the URL printed by the script as a clickable link.

The publishing script rejects symlinks, non-file entries, missing `index.html`, and artifacts larger than 256 MiB. It copies the artifact into staging and publishes it with an atomic rename. Published previews are immutable and expire after 7 days. Create a new preview when the artifact changes.
