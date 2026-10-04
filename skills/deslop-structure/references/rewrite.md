# The rewrite

Rewrite the full post along the chosen Path. Do the rewrite yourself, with this prompt as your instructions.

## Inputs

- The current version: the file at `rewrite_from` from `start-round`.
- The Moves: `moves` from `start-round`. Use each Move's `instruction`. Skip a Move whose author input the user skipped.
- The confirmed author input of this round.
- The Keep list: `keep` from `start-round`.
- The claim ledger: `ledger.md` in the run folder.

## Instructions

1. Carry out every Move. A Move changes the structure of the post: how it opens, how it ends, who speaks, how the body is built, how strong its claims are. Change the text as much as the Move needs. Shortening, reordering, merging and rewording are allowed.
2. Keep every item of the Keep list. These qualities already read human.
3. Keep every entry of the claim ledger: each number, name, claim, recommendation, link and call to action. You can move an entry or say it in other words. Its meaning stays the same.
4. Take new content only from the post itself or from confirmed author input. A Move that asks for a new point, an example or a voice gets it from there: a consequence of what the post says, a caveat it makes, or a point moved from the body. If a Move needs content that neither source has, carry out the part that needs no new facts.
5. Keep the language, the voice and the markdown format of the post. Keep the title line, unless a Move changes it.
6. Write the full post to `write_to`. Write only the post: no notes, no comments, no summary of the changes.

## Completion

The file at `write_to` holds the full post. Every Move that is not skipped is carried out. Every ledger entry and Keep list item is still in the post.
