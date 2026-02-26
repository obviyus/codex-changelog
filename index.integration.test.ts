import { expect, test } from "bun:test";
import { generatePostForTags } from "./index";

const PREVIOUS_TAG = Bun.env.TEST_PREVIOUS_TAG ?? "0.104.0";
const CURRENT_TAG = Bun.env.TEST_CURRENT_TAG ?? "0.105.0";
const CURRENT_VERSION = CURRENT_TAG.replace(/^rust-v/, "").replace(/^v/, "");
const CURRENT_TAG_NORMALIZED = CURRENT_TAG.startsWith("rust-v")
	? CURRENT_TAG
	: `rust-v${CURRENT_TAG.replace(/^v/, "")}`;

test(
	"integration: generate changelog post with real GitHub + Claude flow (no X post)",
	async () => {
		if (!Bun.which("claude")) {
			throw new Error("claude CLI not found in PATH");
		}

		const text = await generatePostForTags(PREVIOUS_TAG, CURRENT_TAG);

		expect(text.startsWith(`🚀 Codex ${CURRENT_VERSION} is out!`)).toBeTrue();
		expect(text).toContain(
			`Changelog: https://github.com/openai/codex/releases/tag/${CURRENT_TAG_NORMALIZED}`,
		);
		expect(text.length).toBeLessThanOrEqual(280);

		const lines = text.split("\n").filter(Boolean);
		const featureLines = lines.slice(1, -1);
		expect(featureLines.length).toBeGreaterThanOrEqual(3);
		expect(featureLines.length).toBeLessThanOrEqual(5);
		for (const line of featureLines) {
			expect(/^\p{Extended_Pictographic}/u.test(line)).toBeTrue();
		}
	},
	{ timeout: 180_000 },
);
