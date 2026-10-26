import { expect, test } from "bun:test";
import {
	entriesSinceState,
	finalizePost,
	generateLatestPost,
	listCliEntries,
	type ChangelogEntry,
	type Release,
} from "./index";

function release(version: string, publishedAt: string, isPrerelease = false): Release {
	return {
		tagName: `rust-v${version}`,
		url: `https://github.com/openai/codex/releases/tag/rust-v${version}`,
		name: version,
		isDraft: false,
		isPrerelease,
		publishedAt,
	};
}

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

test("CLI release pagination follows cursors until the saved state, skipping prereleases", async () => {
	const publishedAt = "2026-08-18T22:26:03Z";
	const pages = new Map<string | null, ReturnType<typeof release>[]>([
		[
			null,
			[
				release("0.202.0-alpha.1", "2026-08-20T00:00:00Z", true),
				release("0.201.0", "2026-08-19T12:00:00Z"),
			],
		],
		["c1", [release("0.200.0", "2026-08-19T00:00:00Z"), release("0.199.0", publishedAt)]],
	]);
	const requested: (string | null)[] = [];

	const entries = await listCliEntries({ key: "rust-v0.199.0", publishedAt }, async (after) => {
		requested.push(after);
		const releases = pages.get(after);
		if (!releases) throw new Error(`unexpected cursor ${after}`);
		return { releases, endCursor: after === null ? "c1" : "c2", hasNextPage: true };
	});

	expect(requested).toEqual([null, "c1"]);
	expect(entries.map((entry) => entry.key)).toEqual([
		"rust-v0.201.0",
		"rust-v0.200.0",
		"rust-v0.199.0",
	]);
});

test("CLI release pagination stops at the first stable release without saved state", async () => {
	const requested: (string | null)[] = [];
	const releases = await listCliEntries(null, async (after) => {
		requested.push(after);
		return {
			releases: [release("0.200.0", "2026-08-19T00:00:00Z")],
			endCursor: "c1",
			hasNextPage: true,
		};
	});

	expect(requested).toEqual([null]);
	expect(releases.map((release) => release.key)).toEqual(["rust-v0.200.0"]);
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

test.skipIf(!Bun.env.OPENROUTER_API_KEY)(
	"integration: generate changelog post with live Codex changelog + OpenRouter (no X post)",
	async () => {
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
