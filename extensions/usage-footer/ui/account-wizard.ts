import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AccountObservation, AuthType } from "../domain.ts";

export interface LabelRow {
	accountKey: string;
	providerId: string;
	authType: AuthType;
	label: string;
	detected?: string;
}

export function validateLabels(rows: readonly LabelRow[]): string | undefined {
	for (const row of rows) {
		if (row.authType === "api_key" && !row.label.trim()) return `A label is required for ${row.providerId}`;
	}
	const seen = new Set<string>();
	for (const row of rows) {
		if (!row.label.trim()) continue;
		const key = `${row.providerId}\0${row.label.trim()}`;
		if (seen.has(key)) return `Labels must be unique within ${row.providerId}`;
		seen.add(key);
	}
	return undefined;
}

export async function showAccountWizard(ctx: ExtensionContext, observations: readonly AccountObservation[]): Promise<LabelRow[] | undefined> {
	const rows: LabelRow[] = observations.map((account) => ({
		accountKey: account.accountKey,
		providerId: account.providerId,
		authType: account.authType,
		label: account.label ?? account.suggestedLabel ?? "",
		detected: account.suggestedLabel,
	}));
	if (rows.length === 0) return [];
	return ctx.ui.custom<LabelRow[] | undefined>((tui, theme, _keybindings, done) => {
		let selected = 0;
		let editing = false;
		let error: string | undefined;
		return {
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					if (editing) editing = false;
					else done(undefined);
				} else if (matchesKey(data, Key.ctrl("s"))) {
					error = validateLabels(rows);
					if (!error) done(rows.map((row) => ({ ...row, label: row.label.trim() })));
				} else if (matchesKey(data, Key.enter)) {
					editing = !editing;
				} else if (!editing && (matchesKey(data, Key.down) || matchesKey(data, Key.tab))) {
					selected = (selected + 1) % rows.length;
				} else if (!editing && (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab")))) {
					selected = (selected - 1 + rows.length) % rows.length;
				} else if (editing && matchesKey(data, Key.backspace)) {
					rows[selected]!.label = rows[selected]!.label.slice(0, -1);
				} else if (editing && data.length === 1 && data >= " ") {
					rows[selected]!.label += data;
				}
				tui.requestRender();
			},
			render(width: number) {
				const lines = [
					theme.fg("accent", theme.bold("Name Provider Accounts")),
					"Labels appear in the footer and usage dashboard.",
					"",
				];
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i]!;
					const marker = i === selected ? ">" : " ";
					const edit = i === selected && editing ? "▌" : "";
					lines.push(`${marker} ${row.providerId.padEnd(20)} ${(row.detected ?? row.authType).padEnd(20)} [${row.label}${edit}]`);
				}
				if (error) lines.push("", theme.fg("error", error));
				lines.push("", theme.fg("dim", "↑↓/tab move  enter edit  ctrl+s save  esc skip for now"));
				return lines.map((line) => truncateToWidth(line, width));
			},
		};
	}, { overlay: true, overlayOptions: { width: "75%", minWidth: 64, maxHeight: "80%", anchor: "center" } });
}
