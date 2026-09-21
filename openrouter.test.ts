import { rejects } from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { generateLatestPost } from "./index";

const bullets = "✨ Better controls\n🔎 Faster search\n🛠️ Bug fixes";
const appHtml = `<ul><li id="codex-2026-05-17-app" data-codex-topics="codex-app">
<div><time>2026-05-17</time><h3>Codex app update</h3></div>
<article>Better controls.</article></li></ul>`;
const release = {
	tag_name: "rust-v0.131.0",
	html_url: "https://github.com/openai/codex/releases/tag/rust-v0.131.0",
	name: "0.131.0",
	body: "Better controls, faster search, and bug fixes.",
	draft: false,
	prerelease: false,
	published_at: "2026-05-18T17:39:34Z",
};

describe("OpenRouter post generation", () => {
	const originalKey = Bun.env.OPENROUTER_API_KEY;
	const originalModel = Bun.env.OPENROUTER_MODEL;
	let requests: Request[];
	let replies: Response[];
	let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

	beforeEach(() => {
		Bun.env.OPENROUTER_API_KEY = "test-key";
		delete Bun.env.OPENROUTER_MODEL;
		requests = [];
		replies = [Response.json({ choices: [{ message: { content: bullets } }] })];
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.hostname === "developers.openai.com") return new Response(appHtml);
			if (url.hostname === "api.github.com") return Response.json([release]);
			expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
			requests.push(request);
			const response = replies.shift();
			if (!response) throw new Error("Unexpected extra generation request");
			return response;
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		if (originalKey === undefined) delete Bun.env.OPENROUTER_API_KEY;
		else Bun.env.OPENROUTER_API_KEY = originalKey;
		if (originalModel === undefined) delete Bun.env.OPENROUTER_MODEL;
		else Bun.env.OPENROUTER_MODEL = originalModel;
	});

	test("uses Opus 5 and preserves the post format", async () => {
		const text = await generateLatestPost();
		expect(text).toBe(
			`🚀 Codex CLI 0.131.0 is out!\n\n${bullets}\n\nChangelog: ${release.html_url}`,
		);
		expect(text.length).toBeLessThanOrEqual(280);
		expect(requests).toHaveLength(1);
		const request = requests[0]!;
		expect(request.method).toBe("POST");
		expect(request.headers.get("Authorization")).toBe("Bearer test-key");
		expect(await request.json()).toMatchObject({
			model: "anthropic/claude-opus-5",
			reasoning: { enabled: false },
			max_tokens: 512,
		});
	});

	test("retries an oversized post with a shorter prompt", async () => {
		replies.unshift(
			Response.json({
				choices: [{ message: { content: `✨ ${"long ".repeat(60)}\n🔎 Search\n🛠️ Fixes` } }],
			}),
		);
		await generateLatestPost();
		expect(requests).toHaveLength(2);
		expect(await requests[1]!.text()).toContain("Your previous answer was too long");
	});

	test("stops on authentication failure without logging the response body", async () => {
		replies = [Response.json({ error: { message: "private provider details" } }, { status: 401 })];
		await rejects(generateLatestPost(), { message: "OpenRouter request failed (HTTP 401)" });
		expect(requests).toHaveLength(1);
	});

	test("rejects a provider error inside an HTTP 200 response", async () => {
		replies = [Response.json({ error: { code: 502, message: "Provider error" } })];
		await rejects(generateLatestPost(), { message: "OpenRouter generation failed (code 502)" });
		expect(requests).toHaveLength(1);
	});

	test("rejects missing completion text", async () => {
		replies = [Response.json({ choices: [{ message: { content: null } }] })];
		await rejects(generateLatestPost(), { message: "OpenRouter response missing post text" });
		expect(requests).toHaveLength(1);
	});
});
