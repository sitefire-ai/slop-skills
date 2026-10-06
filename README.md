# Slop Skills

Agent skills that check a blog post with the [Sitefire Slop API](https://sitefire.ai) and rewrite its structure until the detector reads it as human-written. The terms are in [CONTEXT.md](CONTEXT.md).

## deslop-structure

You give the skill a blog post, as a URL or as a markdown or text file. The skill then does these steps:

1. It checks the post with the Slop API and shows you P(AI), the probability that the post is AI-written.
2. It recommends a Path: a set of structural changes that the API proposes. You confirm the Path, or you let the skill choose.
3. It asks you for facts or links that only you can supply. You can skip each question.
4. It rewrites the post along the Path. It keeps every number, name, claim and link of the original. A separate fidelity check compares the rewrite with the original and finds changed meaning.
5. It checks the post again, and repeats until P(AI) is under the goal (0.2 by default) or you stop it.

A report shows P(AI) by round and what each round changed. The skill never changes your file. It writes the result to `<name>.deslopped.md`, and it keeps every version in a run folder under `./deslop-runs/`.

Word-level rewriting does not help here. In the SlopShape study, a rewrite that changed 73% of the words left structural detection unchanged. This skill changes the structure: how a post opens and ends, who speaks, how the body is built, and how strong its claims are.

## Install

```bash
npx skills add sitefire-ai/slop-skills
```

The skill works in Claude Code, Codex and other tools that read Agent Skills. It needs Node 18 or later. It has no packages to install.

Then ask your agent, for example: "Deslop my post at https://example.com/blog/my-post" or "Deslop drafts/launch.md, goal 0.1, choose the Paths yourself".

## Settings

| You say | Effect |
|---|---|
| a goal, for example "goal 0.1" | The P(AI) to get under. Default 0.2. |
| a number of rounds | The round limit. Default 3. The skill asks before it goes past the limit. |
| "choose the Paths yourself" | Auto path: no confirmation of each Path. |
| "do not ask me questions" | Non-interactive mode. Paths that need your input are dropped. Interactive mode gives better results. |
| "only check it" | The skill checks the post once and changes nothing. |

`SLOP_API_URL` sets the API base URL, for example `http://localhost:3000` for a local deployment. The default is `https://sitefire.ai`.

## This is an experiment

We do not know yet if a post that the detector calls human also reads as less AI-written to people. Every run keeps its before and after versions, so that this can be tested later. The run folders stay on your computer. Each Check sends the post text to the API, and the API stores each Check for 90 days.

## Limits

- **Blog posts only.** The detector learned on blog posts. The skill shows a warning when your text does not look like one.
- **English.** The study measured English posts. For other languages, the API scores the post, but the result is only indicative.
- **The first 2,600 words.** The API scores only the first 2,600 words of a post. The skill rewrites the whole post, so the end of a long post is not measured.
- **300 words to 20,000 characters.** The API refuses shorter or longer texts.
- **30 Checks per day.** The API allows 30 computed Checks per IP address per UTC day. Each round uses one Check. When the API refuses a Check, the skill stops, tells you when to try again, and keeps the run folder.
- **No fact checks.** The API does not check facts or names. Fill every placeholder and make sure that every named person is real before you publish.

The API contract is in `docs/slop-api/README.md` in the sitefire-website repo.

## Development

The run engine is one Node script with no dependencies: [`skills/deslop-structure/scripts/deslop.mjs`](skills/deslop-structure/scripts/deslop.mjs). It calls the API, chooses the next step of a run, and renders the report. Run its tests with:

```bash
npm test
```

The tests drive the engine with recorded Slop API responses in [`test/fixtures`](test/fixtures).

## License

MIT. See [LICENSE](LICENSE).
