# Author input

A Move with `edit: needs_author_input` needs content that only the author can supply: a link, a fact, a named person, a quote. Get it for each such Move of the chosen Path, in this order. Stop at the first source that gives a good candidate.

1. **The post's own site.** Read its `sitemap.xml` and the internal links of the post. Look for a page that fits the Move: a related guide for a resource link, an author page for a named voice, a case study for a customer example.
2. **Connected tools.** Search the tools that your host has connected, for example a CMS, Notion or Google Drive.
3. **The writer.** Ask the user for the content.

## Confirm every candidate

Show the user each candidate that you found, with its source, before it goes into the post. Ask as a numbered question, with "Skip" as the last option. Accept the content that the user writes in place of a candidate.

- A confirmed value: run `deslop author-input <run> --feature <id> --value "<the content>" --source <site|tool|writer>`.
- A skip: run `deslop author-input <run> --feature <id> --skip`. The rewrite then drops this Move.

Do not make up a link, a fact, a name or a quote. If no source has the content, offer the skip.

Done when: each `needs_author_input` Move of the round has a confirmed value or a skip.
