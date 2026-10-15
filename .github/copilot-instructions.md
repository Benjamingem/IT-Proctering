# Project guidance

- Keep authentication and authorization server-side. Employees may only read their own records; never trust a client-supplied role or user ID.
- Use UTC ISO timestamps and server-generated event times. Do not infer productive work from availability.
- Treat unknown network or agent state as unavailable/unknown. Keep camera access off; do not add capture without a separate explicit consent, policy, audit, and retention design.
- Do not collect screenshots, audio, typed content, clipboard data, or synthetic input.
- Add focused Node tests for API behavior. Use temporary SQLite files and controllable idle inputs rather than waiting in real time.
- Preserve the JavaScript monorepo boundaries: `apps/api`, `apps/web`, `apps/desktop`, `packages/shared`, and `database/migrations`.
