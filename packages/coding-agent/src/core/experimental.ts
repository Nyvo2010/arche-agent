export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.ARCHE_EXPERIMENTAL === "1";
}
