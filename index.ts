import { dirname, join } from "node:path";
import { Client, OAuth1 } from "@xdevplatform/xdk";

const OWNER = "openai";
const REPO = "codex";
const STATE_FILE = ".state/last_posted_tag.txt";
const MAX_POST_LEN = 280;

type Release = {
	tag_name: string;
	html_url: string;
	name: string | null;
	body: string | null;
	draft: boolean;
	prerelease: boolean;
	published_at: string | null;
};

type CompareResponse = {
	total_commits: number;
	changed_files?: number;
	files?: { filename: string }[];
};

type ReleasePair = {
	current: Release;
	previous: Release;
};

function normalizeReleaseTag(tag: string): string {
	const trimmed = tag.trim();
	if (!trimmed) throw new Error("Release tag is required");
	if (trimmed.startsWith("rust-v")) return trimmed;
	return `rust-v${trimmed.replace(/^v/, "")}`;
}

async function githubJson<T>(path: string): Promise<T> {
	const token = Bun.env.GITHUB_TOKEN;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "codex-changelog-bot",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const response = await fetch(`https://api.github.com${path}`, { headers });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`GitHub API ${response.status} ${path}\n${text}`);
	}

	return (await response.json()) as T;
}

async function listReleasesUntil(lastTag: string | null): Promise<Release[]> {
	const releases: Release[] = [];

	for (let page = 1; ; page += 1) {
		const pageReleases = await githubJson<Release[]>(
			`/repos/${OWNER}/${REPO}/releases?per_page=100&page=${page}`,
		);
		const publicReleases = pageReleases.filter((release) => !release.draft && !release.prerelease);
		releases.push(...publicReleases);

		if (lastTag) {
			if (releases.some((release) => release.tag_name === lastTag)) return releases;
		} else if (releases.length >= 2) {
			return releases;
		}

		if (pageReleases.length < 100) return releases;
	}
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

async function writeState(path: string, tag: string): Promise<void> {
	const dir = dirname(path);
	if (dir && dir !== ".") await Bun.$`mkdir -p ${dir}`.quiet();
	await Bun.write(path, `${tag}\n`);
}

function pairAt(releases: Release[], currentIndex: number): ReleasePair {
	const current = releases[currentIndex];
	const previous = releases[currentIndex + 1];
	if (!current || !previous) {
		throw new Error(`No previous release found for tag ${current?.tag_name ?? "unknown"}`);
	}
	return { current, previous };
}

function releasePairsSinceTag(releases: Release[], lastTag: string | null): ReleasePair[] {
	if (releases.length < 2) {
		throw new Error("Need at least 2 public releases");
	}

	if (!lastTag) return [pairAt(releases, 0)];
	if (lastTag === releases[0]?.tag_name) return [];

	const anchorIndex = releases.findIndex((release) => release.tag_name === lastTag);
	if (anchorIndex < 0) throw new Error(`State tag not found in releases: ${lastTag}`);

	const pairs: ReleasePair[] = [];
	for (let currentIndex = anchorIndex - 1; currentIndex >= 0; currentIndex -= 1) {
		pairs.push(pairAt(releases, currentIndex));
	}
	return pairs;
}

function parseReleaseVersion(release: Release): string {
	const source = `${release.name ?? ""}\n${release.tag_name}`.trim();
	const match = source.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
	if (!match) throw new Error(`Could not parse release version from ${release.tag_name}`);
	return match[0];
}

function finalizePost(raw: string, releaseUrl: string, version: string): string {
	const linkLine = `Changelog: ${releaseUrl}`;
	const titleLine = `🚀 Codex ${version} is out!`;
	const normalized = raw.replace(/\r\n/g, "\n").trim();
	if (!normalized) throw new Error("claude returned empty post text");

	const featureLines = normalized
		.replace(/(?:\n|^)\s*Changelog:\s*\S+\s*$/i, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^🚀\s*Codex .+ is out!$/i.test(line));

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

async function generatePost(pair: ReleasePair): Promise<string> {
	const claude = claudeBinary();
	const compare = await githubJson<CompareResponse>(
		`/repos/${OWNER}/${REPO}/compare/${pair.previous.tag_name}...${pair.current.tag_name}`,
	);

	const changedFiles = compare.changed_files ?? compare.files?.length ?? 0;
	const releaseName = (pair.current.name ?? pair.current.tag_name).replace(/^rust-v/, "");
	const releaseVersion = parseReleaseVersion(pair.current);
	const previousName = (pair.previous.name ?? pair.previous.tag_name).replace(/^rust-v/, "");
	const notes = pair.current.body?.trim() || "No release notes provided.";

	const basePrompt = [
		"Write feature bullets for one X software changelog post.",
		"Return only feature bullet lines. Do not include title. Do not include changelog URL line.",
		"Hard limits: max 180 chars total; plain text; no hashtags.",
		"Use 3-5 short lines, one feature per line.",
		"Each line must start with an emoji, then a space, then text.",
		`Release: Codex ${releaseName}`,
		`Compared to: ${previousName}`,
		`Stats: ${compare.total_commits} commits, ${changedFiles} files changed.`,
		"Release notes:",
		notes,
		"Return only feature bullet lines.",
	].join("\n\n");

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const prompt =
			attempt === 1
				? basePrompt
				: `${basePrompt}\n\nYour previous answer was too long. Make this version much shorter.`;
		let raw: string;
		try {
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
		} catch (error) {
			if (error instanceof Error) throw error;
			throw error;
		}
		try {
			return finalizePost(raw, pair.current.html_url, releaseVersion);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			lastError = error;
			if (!error.message.includes("chars (>")) throw error;
		}
	}

	throw lastError ?? new Error("claude post generation failed");
}

async function releaseByTag(tag: string): Promise<Release> {
	const normalizedTag = normalizeReleaseTag(tag);
	return githubJson<Release>(`/repos/${OWNER}/${REPO}/releases/tags/${normalizedTag}`);
}

export async function generatePostForTags(
	previousTag: string,
	currentTag: string,
): Promise<string> {
	const [previous, current] = await Promise.all([
		releaseByTag(previousTag),
		releaseByTag(currentTag),
	]);
	return generatePost({ previous, current });
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
	const lastTag = await readState(STATE_FILE);
	const releases = await listReleasesUntil(lastTag);
	if (releases.length < 2) throw new Error("Need at least 2 public releases");

	const pairs = releasePairsSinceTag(releases, lastTag);

	if (pairs.length === 0) {
		console.log(`No new release. latest=${releases[0]?.tag_name}`);
		return;
	}

	const client = xClient();
	for (const [index, pair] of pairs.entries()) {
		const postText = await generatePost(pair);
		const response = await client.posts.create({ text: postText });
		const id = response.data?.id;
		if (!id) throw new Error(`X create post missing id for tag ${pair.current.tag_name}`);

		await writeState(STATE_FILE, pair.current.tag_name);
		console.log(postText);
		if (index < pairs.length - 1) console.log("");
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
