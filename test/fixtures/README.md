# Fixtures

Recorded Slop API response bodies. Each one is the golden result of bundle 1.0.0 (`lib/slop/api/bundle/slop-api-bundle-1.0.0.json` in sitefire-website, `golden.posts[].expected`) in the shape of the route's `200` body. The route sets `token` and `result_url`; here they are placeholders.

| File | Golden post | Band |
|---|---|---|
| `ai_shaped.json` | `async-guide-s` | `ai_shaped`, three Paths |
| `borderline.json` | `async-guide-rs` | `borderline`, one Path |
| `human_shaped.json` | `human-shaped-post` | `human_shaped`, no Paths |

The names are result names, as SF-314 set them. The bodies have the flat shape of the route before SF-323: no `margin`, no `target_p_ai`, and `reaches_band` on each Path. Tests convert copies to the SF-323 shape (`margin` at the top level; `target_p_ai`, `paths`, `keep` and `text` in `feedback`; `reaches_target` on each Path), and edit other fields in copies for the edge cases.
