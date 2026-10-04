# Slop Skills

Agent skills that check a blog post with the Sitefire Slop API and rewrite its structure until it reads as human-shaped. The API and its terms are defined in the sitefire-website repo (`docs/slop-api/README.md`); this glossary uses them unchanged.

## Language

### What the API answers

**Check**:
One call to the Slop API on one version of a post.
_Avoid_: Scan, scoring, evaluation

**P(AI)**:
The API's calibrated probability that a post is AI-written, on a 50/50 base rate.
_Avoid_: AI score, slop score, P(human)

**Margin**:
The detector's raw score before calibration. It still moves while P(AI) stays at 1.00, so it shows progress that P(AI) hides.
_Avoid_: Logit, raw score

**Band**:
The class P(AI) falls into: `human_shaped` (below 0.3), `borderline` (0.3 to 0.7) or `ai_shaped` (from 0.7).
_Avoid_: Label, grade, verdict

**Feature**:
One question from the SlopShape instrument about a post's structure, with a fixed menu of answers.
_Avoid_: Signal (the Checker's word for its ten core features), criterion

**Path**:
An ordered set of Moves that the API proposes to bring a post into the human band.
_Avoid_: Plan, direction, strategy

**Move**:
One change of one feature from the post's current value to a target value, with a one-sentence instruction.
_Avoid_: Edit, feature change, suggestion

**Edit kind**:
How a Move is carried out: `local`, `structural`, or `needs_author_input`.

**Keep list**:
Up to five qualities of the post that already read human and must survive every rewrite.
_Avoid_: Strengths, protected features

### Running the loop

**Run**:
One invocation on one post, stored in its own folder with every version, Check and decision.

**Goal**:
The P(AI) a run aims to get below, 0.2 by default. It sits deeper than the human band's 0.3 boundary.
_Avoid_: Target band, threshold

**Round**:
One rewrite along a chosen Path, its fidelity check, and the Check of the result.
_Avoid_: Iteration, pass, loop

**Constraint**:
Any rule outside the API that the post must follow and that is known from the context, such as a house style or a required closing CTA. A Path that would breach one is not recommended.
_Avoid_: Writing guidelines, style guide

**Author input**:
Content only the author can supply, such as a link or a fact, that a `needs_author_input` Move requires.
_Avoid_: Author to-do

**Interactive mode**:
A run in which the skill asks the user to confirm the Path, supply author input, and allow extra rounds.

**Auto path**:
A run setting in which the user lets the skill choose the Path without confirmation.

### Keeping the meaning

**Claim ledger**:
The list of numbers, names, claims, recommendations and links taken from the original post before any rewrite.

**Fidelity check**:
The adversarial comparison of a rewritten version against the original that finds changed meaning.
