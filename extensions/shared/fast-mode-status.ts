export const FAST_MODE_STATUS_KEY = "openai-fast-mode";
export const FAST_MODE_STATUS_EVENT = "mical:fast-mode-status";

export interface FastModeStatus {
	active: boolean;
}
