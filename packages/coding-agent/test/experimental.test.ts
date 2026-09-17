import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.ARCHE_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.ARCHE_EXPERIMENTAL;
		} else {
			process.env.ARCHE_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when ARCHE_EXPERIMENTAL is unset", () => {
		delete process.env.ARCHE_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ARCHE_EXPERIMENTAL is empty", () => {
		process.env.ARCHE_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when ARCHE_EXPERIMENTAL is set to 1", () => {
		process.env.ARCHE_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when ARCHE_EXPERIMENTAL is set to 0", () => {
		process.env.ARCHE_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ARCHE_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.ARCHE_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
