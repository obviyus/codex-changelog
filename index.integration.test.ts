import { expect, test } from "bun:test";
import { entriesSinceState, finalizePost, generateLatestPost, type ChangelogEntry } from "./index";

const baseEntry = {
	topic: "codex-cli",
	date: "2026-05-18",
	title: "Codex CLI",
	version: "0.131.0",
	url: "https://github.com/openai/codex/releases/tag/rust-v0.131.0",
	body: "Release notes.",
} satisfies Omit<ChangelogEntry, "key" | "id" | "publishedAt">;

test("state cursor survives removed changelog ids", () => {
	const entries: ChangelogEntry[] = [
		{
			...baseEntry,
			key: "codex-2026-05-07",
			id: "codex-2026-05-07",
			topic: "codex-app",
			publishedAt: "2026-05-07T00:00:00Z",
		},
	];

	expect(
		entriesSinceState(entries, {
			key: "codex-2026-05-13-app",
			publishedAt: "2026-05-14T00:00:00Z",
		}),
	).toEqual([]);
});

test("state cursor returns newer releases oldest first", () => {
	const entries: ChangelogEntry[] = [
		{
			...baseEntry,
			key: "rust-v0.132.0",
			id: "rust-v0.132.0",
			publishedAt: "2026-05-19T01:00:00Z",
		},
		{
			...baseEntry,
			key: "rust-v0.131.0",
			id: "rust-v0.131.0",
			publishedAt: "2026-05-18T17:39:34Z",
		},
		{
			...baseEntry,
			key: "rust-v0.130.0",
			id: "rust-v0.130.0",
			publishedAt: "2026-05-08T23:09:55Z",
		},
	];

	expect(
		entriesSinceState(entries, {
			key: "rust-v0.130.0",
			publishedAt: "2026-05-08T23:09:55Z",
		}).map((entry) => entry.key),
	).toEqual(["rust-v0.131.0", "rust-v0.132.0"]);
});

test("post finalizer accepts outer code fences", () => {
	const entry: ChangelogEntry = {
		...baseEntry,
		key: "rust-v0.131.0",
		id: "rust-v0.131.0",
		publishedAt: "2026-05-18T17:39:34Z",
	};

	expect(
		finalizePost(
			"```text\n✨ Better TUI controls\n🔎 Unified mention picker\n🛠️ Remote workflow APIs\n```",
			entry,
		),
	).toContain("🚀 Codex CLI 0.131.0 is out!");
});

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
