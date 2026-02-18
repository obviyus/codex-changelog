import { dirname } from "node:path";

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

type GeneratedPost = {
	tag: string;
	text: string;
};

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

function finalizePost(raw: string, releaseUrl: string): string {
	const linkLine = `Changelog: ${releaseUrl}`;
	const normalized = raw.replace(/\r\n/g, "\n").trim();
	if (!normalized) throw new Error("claude returned empty post text");
	if (!normalized.includes("\n")) throw new Error("claude returned single-line post");

	let body = normalized.replace(/(?:\n|^)\s*Changelog:\s*\S+\s*$/i, "").trim();
	if (!body) throw new Error("claude returned only changelog line");

	const lines = body.split("\n").map((line) => line.trimEnd());
	if (lines.length > 1 && lines[0] && lines[1] !== "") lines.splice(1, 0, "");
	body = lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	const text = `${body}\n\n${linkLine}`;
	if (text.length > MAX_POST_LEN) {
		throw new Error(`claude returned ${text.length} chars (> ${MAX_POST_LEN})`);
	}

	return text;
}

async function generatePost(pair: ReleasePair): Promise<GeneratedPost> {
	const compare = await githubJson<CompareResponse>(
		`/repos/${OWNER}/${REPO}/compare/${pair.previous.tag_name}...${pair.current.tag_name}`,
	);

	const changedFiles = compare.changed_files ?? compare.files?.length ?? 0;
	const releaseName = (pair.current.name ?? pair.current.tag_name).replace(/^rust-v/, "");
	const previousName = (pair.previous.name ?? pair.previous.tag_name).replace(/^rust-v/, "");
	const notes = pair.current.body?.trim() || "No release notes provided.";

	const prompt = [
		"Write one X post for a software changelog.",
		"Hard limits: max 280 chars total; plain text; no hashtags.",
		"Use a simple emoji at the start of every non-empty line.",
		"Use 3-5 short lines.",
		`Release: Codex ${releaseName}`,
		`Compared to: ${previousName}`,
		`Stats: ${compare.total_commits} commits, ${changedFiles} files changed.`,
		"Release notes:",
		notes,
		`End with exact line: "Changelog: ${pair.current.html_url}"`,
		"Return only post text.",
	].join("\n\n");

	const raw = (await Bun.$`claude -p ${prompt}`.quiet().text()).trim();
	return {
		tag: pair.current.tag_name,
		text: finalizePost(raw, pair.current.html_url),
	};
}

async function main(): Promise<void> {
	const allReleases = await githubJson<Release[]>(`/repos/${OWNER}/${REPO}/releases?per_page=30`);
	const releases = allReleases.filter((release) => !release.draft && !release.prerelease);
	if (releases.length < 2) throw new Error("Need at least 2 public releases");

	const lastTag = await readState(STATE_FILE);
	const pairs = releasePairsSinceTag(releases, lastTag);

	if (pairs.length === 0) {
		console.log(`No new release. latest=${releases[0]?.tag_name}`);
		return;
	}

	const posts = await Promise.all(pairs.map(generatePost));
	for (const [index, post] of posts.entries()) {
		console.log(post.text);
		if (index < posts.length - 1) console.log("");
	}

	const newest = posts[posts.length - 1]?.tag;
	if (!newest) throw new Error("Internal: missing newest generated tag");
	await writeState(STATE_FILE, newest);
}

main().catch((error: unknown) => {
	if (error instanceof Error) {
		console.error(error.message);
	} else {
		console.error(String(error));
	}
	process.exit(1);
});
