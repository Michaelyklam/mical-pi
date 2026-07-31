import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface BorderTheme { fg(role: string, text: string): string }

/** Draw an ANSI-safe, full-width frame around an extension-owned menu. */
export function frameMenu(lines: string[], width: number, theme: BorderTheme): string[] {
	if (width < 4) return lines.map((line) => truncateToWidth(line, width));
	const innerWidth = width - 2;
	const edge = (text: string) => theme.fg("borderAccent", text);
	return [
		edge(`┌${"─".repeat(innerWidth)}┐`),
		...lines.map((line) => {
			const content = truncateToWidth(line, innerWidth);
			return `${edge("│")}${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))}${edge("│")}`;
		}),
		edge(`└${"─".repeat(innerWidth)}┘`),
	];
}
