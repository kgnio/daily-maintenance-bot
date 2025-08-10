import { Octokit } from "@octokit/rest";
import fs from "node:fs/promises";
import pLimit from "p-limit";

const TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GH_PAT/GITHUB_TOKEN");
  process.exit(1);
}
const octokit = new Octokit({ auth: TOKEN });
const limit = pLimit(6); // GitHub API için makul paralellik

function mdTable(rows) {
  if (!rows.length) return "";
  const header = Object.keys(rows[0]);
  const sep = header.map(() => "---");
  const body = rows.map((r) =>
    header.map((h) => String(r[h] ?? "")).join(" | ")
  );
  return [header.join(" | "), sep.join(" | "), ...body].join("\n");
}

function insertBetweenMarkers(content, start, end, block) {
  const s = `<!-- ${start} -->`;
  const e = `<!-- ${end} -->`;
  const startIdx = content.indexOf(s);
  const endIdx = content.indexOf(e);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  return (
    content.slice(0, startIdx + s.length) +
    "\n" +
    block +
    "\n" +
    content.slice(endIdx)
  );
}

function aggregateLanguages(langMaps) {
  const total = {};
  for (const m of langMaps) {
    for (const [k, v] of Object.entries(m)) total[k] = (total[k] || 0) + v;
  }
  const sum = Object.values(total).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(total)
    .map(([lang, bytes]) => ({
      lang,
      pct: ((bytes / sum) * 100).toFixed(1) + "%",
    }))
    .sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct))
    .slice(0, 10);
}

const nowISO = new Date().toISOString();

try {
  // 1) Identity
  const { data: me } = await octokit.rest.users.getAuthenticated();
  const username = me.login;

  // 2) Repos (owned, public)
  const repos = await octokit.paginate(
    octokit.rest.repos.listForAuthenticatedUser,
    {
      visibility: "public",
      per_page: 100,
      affiliation: "owner",
      sort: "pushed",
      direction: "desc",
    }
  );
  const own = repos.filter((r) => !r.fork);

  // Totals
  const totalStars = own.reduce((a, r) => a + (r.stargazers_count || 0), 0);
  const totalForks = own.reduce((a, r) => a + (r.forks_count || 0), 0);

  // Languages (first 30 repos)
  const langs = [];
  for (const r of own.slice(0, 30)) {
    const { data } = await octokit.rest.repos.getLanguages({
      owner: username,
      repo: r.name,
    });
    langs.push(data || {});
  }
  const langAgg = aggregateLanguages(langs);

  // Last 5 repos
  const recent5 = own.slice(0, 5).map((r) => ({
    Repo: `[${r.name}](${r.html_url})`,
    Stars: r.stargazers_count,
    Forks: r.forks_count,
    Updated: new Date(r.pushed_at).toISOString().split("T")[0],
  }));

  // ===== New: Issues & PRs summary =====
  let totalOpenIssues = 0;
  let totalOpenPRs = 0;
  await Promise.all(
    own.map((r) =>
      limit(async () => {
        // open issues (excluding PRs is tricky if using open_issues_count; do explicit calls)
        const pulls = await octokit.paginate(octokit.rest.pulls.list, {
          owner: username,
          repo: r.name,
          state: "open",
          per_page: 100,
        });
        totalOpenPRs += pulls.length;

        const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
          owner: username,
          repo: r.name,
          state: "open",
          per_page: 100,
        });
        // Filter out PRs from issues list (issues API returns PRs with pull_request field)
        totalOpenIssues += issues.filter((i) => !i.pull_request).length;
      })
    )
  );

  // ===== New: Top Contributors (aggregate across top 5 repos by stars) =====
  const topRepos = [...own]
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, 5);
  const contributorMap = new Map(); // key: login, value: {login, url, avatar, contributions}
  await Promise.all(
    topRepos.map((r) =>
      limit(async () => {
        const contributors = await octokit.paginate(
          octokit.rest.repos.listContributors,
          {
            owner: username,
            repo: r.name,
            per_page: 100,
            anon: false,
          }
        );
        for (const c of contributors) {
          if (!c.login) continue;
          const key = c.login.toLowerCase();
          const prev = contributorMap.get(key) || {
            login: c.login,
            url: c.html_url,
            avatar: c.avatar_url,
            contributions: 0,
          };
          prev.contributions += c.contributions || 0;
          contributorMap.set(key, prev);
        }
      })
    )
  );
  const topContribs = [...contributorMap.values()]
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, 10);

  // Markdown blocks
  const summary = [
    `**Update:** ${nowISO}`,
    `**Total Public Repos:** ${own.length}`,
    `**Total Stars:** ${totalStars} • **Total Forks:** ${totalForks}`,
    `**Open Issues:** ${totalOpenIssues} • **Open PRs:** ${totalOpenPRs}`,
  ].join("  \n");

  const langsMd = mdTable(
    langAgg.map((x) => ({ Language: x.lang, Percentage: x.pct }))
  );
  const recentMd = mdTable(recent5);

  const contribsMd =
    mdTable(
      topContribs.map((c) => ({
        Contributor: `[${c.login}](${c.url})`,
        Contributions: c.contributions,
      }))
    ) || "_No data found_";

  // Load README, update sections
  let readme = await fs.readFile("README.md", "utf8");

  readme = insertBetweenMarkers(readme, "STATS:START", "STATS:END", summary);
  readme = insertBetweenMarkers(
    readme,
    "LANGS:START",
    "LANGS:END",
    langsMd || "_No data found_"
  );
  readme = insertBetweenMarkers(
    readme,
    "RECENT:START",
    "RECENT:END",
    recentMd || "_No data found_"
  );
  readme = insertBetweenMarkers(
    readme,
    "CONTRIB:START",
    "CONTRIB:END",
    contribsMd
  );

  // Write if changed
  const old = await fs.readFile("README.md", "utf8");
  if (readme.trim() !== old.trim()) {
    await fs.writeFile("README.md", readme);
    console.log("README updated.");
  } else {
    console.log("No changes.");
  }
} catch (e) {
  console.error(e);
  process.exit(1);
}
