# The claim ledger and the meaning check

## Part 1: the claim ledger

Make the ledger once, from the original post (`versions/v0.md` in the run folder), before the first rewrite. Write it to `ledger.md` in the run folder.

List every item of these kinds, one per line, with a short quote from the post:

1. Numbers, with their unit and what they count.
2. Names of people, companies, products, places and sources.
3. Claims: statements that something is true, causes something, or is better or worse.
4. Recommendations: what the post tells the reader to do or not to do.
5. Links, with their text and target.
6. Calls to action: what the post asks the reader to do next, for example to book a demo.

Done when: every sentence of the post that holds one of these items has its items in the ledger.

## Part 2: the meaning check

The meaning check is adversarial: its job is to find changed meaning. Run it in a subagent if your host has subagents. If it has none, run it as a separate prompt. Give it only these inputs and the prompt below:

- the original post (`versions/v0.md`)
- the rewrite (`write_to` of this round)
- the claim ledger (`ledger.md`)
- the confirmed author input of every round so far
- the Keep list of this round

Write its answer to `fidelity/round-<n>.md` in the run folder.

### Prompt for the meaning check

> You compare a rewrite of a blog post with its original. Find every place where the rewrite changes the meaning. A structural change is allowed: a new order, a new opening or ending, a new voice, shorter text, a claim that is less strong than before. These changes are failures:
>
> 1. A ledger entry is missing, or its meaning changed. A number, a name, a link target or a call to action changed.
> 2. The rewrite adds a fact, a number, a name, a quote or a link that is not in the original or in the confirmed author input.
> 3. A recommendation now says a different thing, or the opposite.
> 4. An item of the Keep list is gone.
>
> Examine each ledger entry one at a time. Then read the rewrite for added content. Answer with `PASS` or `FAIL` on the first line. Then give `<kept> of <total> ledger entries kept`. Then list each failure with a quote from the original and a quote from the rewrite.

## After the check

- `PASS`: record it with `deslop fidelity <run> --pass --summary "<kept> of <total> claims kept"`.
- `FAIL`: correct the listed failures in the rewrite and run the check again, one time. If it fails again, record it with `deslop fidelity <run> --fail --summary "<the failures, short>"`.
