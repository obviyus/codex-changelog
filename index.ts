import { dirname, join } from "node:path";
import { Client, OAuth1 } from "@xdevplatform/xdk";

const CHANGELOG_URL = "https://developers.openai.com/codex/changelog";
const STATE_FILE = ".state/last_posted_key.txt";
const MAX_POST_LEN = 280;
const TARGET_TOPICS = new Set(["codex-app", "codex-cli"]);

type ChangelogTopic = "codex-app" | "codex-cli";

type ChangelogEntry = {
	key: string;
	id: string;
	topic: ChangelogTopic;
	date: string;
	title: string;
	version: string | null;
	url: string;
	body: string;
};

function topicLabel(topic: ChangelogTopic): string {
	return topic === "codex-app" ? "Codex app" : "Codex CLI";
}

function normalizeCliVersion(version: string): string {
	return version.replace(/^rust-v/, "").replace(/^v/, "");
}

function entryKey(topic: ChangelogTopic, id: string, version: string | null): string {
	if (topic === "codex-cli" && version) return `rust-v${normalizeCliVersion(version)}`;
	return id;
}

function postTitle(entry: ChangelogEntry): string {
	if (entry.version) return `🚀 ${topicLabel(entry.topic)} ${entry.version} is out!`;
	if (entry.topic === "codex-app") return "🚀 Codex app update";
	return "🚀 Codex CLI update";
}

function featureCharBudget(entry: ChangelogEntry): number {
	return MAX_POST_LEN - postTitle(entry).length - `Changelog: ${entry.url}`.length - 6;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replace(/&#(\d+);/g, (_, codePoint: string) => String.fromCodePoint(Number(codePoint)))
		.replace(/&#x([0-9a-f]+);/gi, (_, codePoint: string) =>
			String.fromCodePoint(Number.parseInt(codePoint, 16)),
		);
}

function htmlToText(html: string): string {
	const withoutNoise = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<svg[\s\S]*?<\/svg>/gi, "")
		.replace(/<button[\s\S]*?<\/button>/gi, "")
		.replace(/<img\b[^>]*>/gi, "");

	const withBreaks = withoutNoise
		.replace(/<\/(p|h1|h2|h3|h4|h5|h6|div|section|article|ul|ol|details)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/li>/gi, "\n");

	return decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ""))
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
}

function parseVersion(title: string): string | null {
	const match = title.match(/\b(\d+\.\d+(?:\.\d+)?)\s*$/);
	return match?.[1] ?? null;
}

function parseTitle(html: string): { title: string; version: string | null } {
	const text = htmlToText(html);
	const version = parseVersion(text);
	if (!version) return { title: text, version: null };
	return { title: text.slice(0, -version.length).trim(), version };
}

function promptNotes(body: string): string {
	return body.split("\n").slice(0, 12).join("\n");
}

async function changelogHtml(): Promise<string> {
	const response = await fetch(CHANGELOG_URL);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Changelog ${response.status} ${CHANGELOG_URL}\n${text}`);
	}
	return response.text();
}

async function listEntries(): Promise<ChangelogEntry[]> {
	const html = await changelogHtml();
	const response = new HTMLRewriter()
		.on("li[data-codex-topics]", {
			element(element) {
				const topic = element.getAttribute("data-codex-topics");
				if (!topic || !TARGET_TOPICS.has(topic)) return;
				const id = element.getAttribute("id");
				if (!id) throw new Error("Changelog entry missing id");
				element.before(`\nENTRY_START\t${id}\t${topic}\n`, { html: false });
				element.after("\nENTRY_END\n", { html: false });
			},
		})
		.on("li[data-codex-topics] > div time", {
			element(element) {
				element.before("\nDATE_START\n", { html: false });
				element.after("\nDATE_END\n", { html: false });
			},
		})
		.on("li[data-codex-topics] > div h3", {
			element(element) {
				element.before("\nTITLE_START\n", { html: false });
				element.after("\nTITLE_END\n", { html: false });
			},
		})
		.on("li[data-codex-topics] > article", {
			element(element) {
				element.before("\nBODY_START\n", { html: false });
				element.after("\nBODY_END\n", { html: false });
			},
		})
		.transform(new Response(html));
	const markedHtml = await response.text();

	const blocks = [...markedHtml.matchAll(/ENTRY_START\t([^\t\n]+)\t([^\n]+)\n([\s\S]*?)\nENTRY_END/g)];
	const entries = blocks.map((match) => {
		const id = match[1];
		const topic = match[2];
		const block = match[3];
		if (!id || !topic || !block) throw new Error("Malformed changelog entry block");
		if (topic !== "codex-app" && topic !== "codex-cli") {
			throw new Error(`Unexpected topic: ${topic}`);
		}
		const date = block.match(/DATE_START\n([\s\S]*?)\nDATE_END/)?.[1];
		const titleHtml = block.match(/TITLE_START\n([\s\S]*?)\nTITLE_END/)?.[1];
		const bodyHtml = block.match(/BODY_START\n([\s\S]*?)\nBODY_END/)?.[1];
		if (!date || !titleHtml || !bodyHtml) throw new Error(`Incomplete changelog entry: ${id}`);
		const parsedTitle = parseTitle(titleHtml);
		return {
			id,
			topic,
			date: htmlToText(date),
			title: parsedTitle.title,
			version: parsedTitle.version,
			url: `${CHANGELOG_URL}#${id}`,
			body: htmlToText(bodyHtml),
			key: entryKey(topic, id, parsedTitle.version),
		} satisfies ChangelogEntry;
	});

	if (entries.length === 0) throw new Error("No Codex app or CLI changelog entries found");
	return entries;
}

function entriesSinceKey(entries: ChangelogEntry[], lastKey: string | null): ChangelogEntry[] {
	if (!lastKey) return entries.slice(0, 1).reverse();
	if (lastKey === entries[0]?.key) return [];

	const anchorIndex = entries.findIndex((entry) => entry.key === lastKey);
	if (anchorIndex < 0) throw new Error(`State key not found in changelog: ${lastKey}`);

	return entries.slice(0, anchorIndex).reverse();
}

function requiredEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

function claudeBinary(): string {
	return join(import.meta.dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
}

async function readState(path: string): Promise<string | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	const text = (await file.text()).trim();
	return text.length > 0 ? text : null;
}

async function writeState(path: string, value: string): Promise<void> {
	const dir = dirname(path);
	if (dir && dir !== ".") await Bun.$`mkdir -p ${dir}`.quiet();
	await Bun.write(path, `${value}\n`);
}

function finalizePost(raw: string, entry: ChangelogEntry): string {
	const titleLine = postTitle(entry);
	const linkLine = `Changelog: ${entry.url}`;
	const normalized = raw.replace(/\r\n/g, "\n").trim();
	if (!normalized) throw new Error("claude returned empty post text");

	const featureLines = normalized
		.replace(/(?:\n|^)\s*Changelog:\s*\S+\s*$/i, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => line !== titleLine);

	if (featureLines.length < 3 || featureLines.length > 5) {
		throw new Error(`claude returned ${featureLines.length} feature lines (expected 3-5)`);
	}

	for (const line of featureLines) {
		if (!/^\p{Extended_Pictographic}/u.test(line)) {
			throw new Error(`feature line must start with emoji: ${line}`);
		}
	}

	const text = `${titleLine}\n\n${featureLines.join("\n")}\n\n${linkLine}`;
	if (text.length > MAX_POST_LEN) {
		throw new Error(`claude returned ${text.length} chars (> ${MAX_POST_LEN})`);
	}

	return text;
}

async function generatePost(entry: ChangelogEntry): Promise<string> {
	const claude = claudeBinary();
	const notes = promptNotes(entry.body.trim() || "No changelog details provided.");
	const charBudget = featureCharBudget(entry);

	const basePrompt = [
		"Write feature bullets for one X software changelog post.",
		"Return only feature bullet lines. Do not include title. Do not include changelog URL line.",
		`Hard limit: max ${charBudget} chars total across all bullet lines combined; plain text; no hashtags.`,
		"Use exactly 3 short lines, one feature per line.",
		"Each line must start with an emoji, then a space, then text.",
		"Prefer terse noun phrases over sentences.",
		`Product: ${topicLabel(entry.topic)}`,
		`Published: ${entry.date}`,
		`Headline: ${entry.title}`,
		entry.version ? `Version: ${entry.version}` : null,
		"Changelog details:",
		notes,
		"Return only feature bullet lines.",
	]
		.filter(Boolean)
		.join("\n\n");

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const prompt =
			attempt === 1
				? basePrompt
				: `${basePrompt}\n\nYour previous answer was too long. Use much shorter wording. Keep all 3 lines together under ${charBudget} chars total.`;
		let raw: string;
		const proc = Bun.spawn(
			[process.execPath, claude, "-p", "--permission-mode", "bypassPermissions", prompt],
			{
				env: Bun.env,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			proc.stdout.text(),
			proc.stderr.text(),
			proc.exited,
		]);
		if (exitCode !== 0) {
			const details = [`exit=${exitCode}`, stderr.trim() || null, stdout.trim() || null]
				.filter(Boolean)
				.join("\n");
			throw new Error(details ? `claude -p failed\n${details}` : "claude -p failed");
		}
		raw = stdout.trim();

		try {
			return finalizePost(raw, entry);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			lastError = error;
			if (!error.message.includes("chars (>")) throw error;
		}
	}

	throw lastError ?? new Error("claude post generation failed");
}

export async function generateLatestPost(): Promise<string> {
	const entries = await listEntries();
	const latestEntry = entries[0];
	if (!latestEntry) throw new Error("No changelog entries found");
	return generatePost(latestEntry);
}

function xClient(): Client {
	const oauth1 = new OAuth1({
		apiKey: requiredEnv("X_API_KEY"),
		apiSecret: requiredEnv("X_API_SECRET"),
		accessToken: requiredEnv("X_ACCESS_TOKEN"),
		accessTokenSecret: requiredEnv("X_ACCESS_TOKEN_SECRET"),
		callback: "oob",
	});
	return new Client({ oauth1 });
}

async function main(): Promise<void> {
	const lastKey = await readState(STATE_FILE);
	const entries = await listEntries();
	const pendingEntries = entriesSinceKey(entries, lastKey);

	if (pendingEntries.length === 0) {
		console.log(`No new changelog entry. latest=${entries[0]?.key}`);
		return;
	}

	const client = xClient();
	for (const [index, entry] of pendingEntries.entries()) {
		const postText = await generatePost(entry);
		const response = await client.posts.create({ text: postText });
		const id = response.data?.id;
		if (!id) throw new Error(`X create post missing id for entry ${entry.key}`);

		await writeState(STATE_FILE, entry.key);
		console.log(postText);
		if (index < pendingEntries.length - 1) console.log("");
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		if (error instanceof Error) {
			console.error(error.message);
		} else {
			console.error(String(error));
		}
		process.exit(1);
	});
}
