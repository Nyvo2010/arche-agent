import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.ARCHE_CODING_AGENT = "true";
	process.env.AI_AGENT = "arche-agent";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
