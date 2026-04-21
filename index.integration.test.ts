import { expect, test } from "bun:test";
import { generateLatestPost } from "./index";

test(
	"integration: generate changelog post with live Codex changelog + Claude flow (no X post)",
	async () => {
		if (!Bun.which("claude")) {
			throw new Error("claude CLI not found in PATH");
		}

		const text = await generateLatestPost();

		expect(text.startsWith("🚀 ")).toBeTrue();
		expect(
			/Changelog: https:\/\/(?:developers\.openai\.com\/codex\/changelog#|github\.com\/openai\/codex\/releases\/tag\/)/.test(
				text,
			),
		).toBeTrue();
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
