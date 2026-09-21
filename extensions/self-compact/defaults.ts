/**
 * Default thresholds for the self-compact extension. Edit here to change the shipped defaults.
 *
 * LOCAL CHANGE vs upstream (disler/self-compact-pi-agent): upstream ships percentage defaults
 * (`{ softAt: "10%", at: "20%", buffer: "10%" }`) that are recomputed against whatever context
 * window the active model reports. Here the defaults are FIXED token counts derived from a
 * nominal 1,000,000-token baseline, so the notice/warning lines do not silently move when the
 * active model changes:
 *
 *   notice      100,000 tokens   (~10% of the 1M baseline)   --compact-soft-at 100000
 *   warning     200,000 tokens   (~20% of the 1M baseline)   --compact-at 200000
 *   hard cutoff warning + buffer = ~300,000 tokens (~30%)    --compact-buffer 100000
 *
 * The hard cutoff is still the warning line plus the buffer, capped at 90% of the ACTUAL model
 * window (HARD_CAP_FRACTION). For example `openai-codex/gpt-6-astra` reports a 272,000-token
 * window, so the forced line caps at 244,800 (90%) while notice/warning stay 100,000/200,000.
 *
 * Explicit CLI flags accept percentages (resolved against the active window), token counts
 * (`270000`, `100k`, `1.5m`), or a mix. Defaults that do not fit a small window are clamped
 * down (see thresholds.ts); explicit values that violate the ordering or the cap are rejected
 * and leave the extension inert.
 *
 * Override at launch with the CLI flags, e.g.
 *   pi -e extensions/self-compact/index.ts --compact-soft-at 15% --compact-at 40% --compact-buffer 5%
 */
export interface ThresholdSpecs {
	/** --compact-soft-at: notice line. */
	softAt: string;
	/** --compact-at: warning line. */
	at: string;
	/** --compact-buffer: allowance above the warning line before the hard cutoff (0 = cutoff at the warning line). */
	buffer: string;
}

/** The nominal baseline the fixed-token defaults are derived from (~10% / ~20% / ~30%). */
export const DEFAULT_BASELINE_TOKENS = 1_000_000;

export const DEFAULT_SPECS: ThresholdSpecs = { softAt: "100000", at: "200000", buffer: "100000" };

/** The hard cutoff never sits above this fraction of the model window. */
export const HARD_CAP_FRACTION = 0.9;
