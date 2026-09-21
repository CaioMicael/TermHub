# TermHub

TermHub is a desktop terminal IDE for running multiple AI coding agents side by side on Windows.

## The problem

Running 5-6 AI agents in parallel, each in its own terminal, does not work well on Windows. Every terminal is a loose window: grouping them into one window is possible but works poorly, alt-tab between groups is unreliable, closing a tab by accident means starting over (new terminal, navigate back to the folder, hope the agent's context survives), and there is no way to tell at a glance which agent finished, which one is stuck waiting for you to answer, and which one is just idle. Watching five terminals is a manual, constant chore.

Existing terminal emulators (Windows Terminal, Tabby, WezTerm) don't help because they are emulators: they know nothing about what is running inside the pane. TermHub treats an agent's terminal session as a first-class object instead: it has a name, belongs to a project, has an observable state, and survives the window closing.

## What makes it different

- **A background daemon owns the PTYs, not the window.** Terminal sessions run in a detached daemon process. Closing the TermHub window, or even the window crashing, does not kill the agents underneath it.
- **Reopening a closed tab restores a live session**, scrollback included — not a fresh shell in the same folder.
- **Session state is visible at a glance**: running, waiting for you, or idle, shown as a status indicator per session.
- **Splits are organized by project**: tabs are workspaces/projects, and terminals are panes arranged in a grid inside each tab.

## Status

Early development. Not usable yet. The scaffold (build tooling, workspace layout, CI) is being put together first; there is no application code yet.

## Development

This is an npm workspaces monorepo. Once the scaffold lands (see `docs/milestones.md`, tasks M0.2-M0.4), the expected commands are:

```
npm install
npm run dev
npm test
npm run lint
npm run typecheck
```

These scripts do not fully work yet — `package.json`, the workspace packages, and the tooling configuration are being added incrementally across the M0 milestone tasks. This section will be updated as each piece lands.

## Documentation

- [`docs/plan.md`](./docs/plan.md) — architecture, technical decisions, and the milestone roadmap.
- [`docs/milestones.md`](./docs/milestones.md) — the task-by-task execution backlog.

## License

MIT — see [LICENSE](./LICENSE).
