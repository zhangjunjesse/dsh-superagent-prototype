# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Jarvis in this fork

This fork adds a single user-facing assistant to the existing DSH bundle. Users talk to Jarvis; the original superagent runtime handles authorized background work. The assistant has its own DSH session, settings, model controls and tool preferences. A durable Gateway connects task submission, status queries and results without making the conversation wait for a worker to finish.

- **Interface and session:** [Jarvis](jarvis/README.md) and [DSH integration](jarvis/DSH-INTEGRATION.md). The functional entry is the **贾维斯** item in the DSH Web sidebar; `jarvis-demo/` contains earlier design references.
- **Background work:** [Gateway integration and boundaries](docs/jarvis-gateway-integration.md), [design](docs/jarvis-gateway-design.md), and [implementation evidence](docs/jarvis-gateway-progress.md). A task does not require a GitHub Issue or a PR deliverable. The underlying runtime still requires its repository/account deployment setup.
- **GitHub setup:** [Connection workflow](docs/github-connection-progress.md). Connect a repository using its URL or `owner/repository`, with a Token or an existing CLI account. Account connection and automatic GitHub message reception are separate settings. Managed Token storage currently uses Windows CurrentUser DPAPI.
- **Project constraints and checks:** [AGENTS.md](AGENTS.md). The original authorization and execution rules remain the foundation; the Gateway adds constrained dispatch at their existing entry points.

The integrated Windows DSH Web profile has completed a real-model, read-only public-repository task and delivered its result back to Jarvis. Controlled tests cover additional routing, isolation and recovery cases. This is not evidence of private-repository access, remote push, Issue-to-PR completion, or production readiness; current verification limits and known test failures are recorded in the linked documents.

Jarvis and its Gateway are optional bundle entries and are disabled by default. Follow the integration documentation for an isolated profile; installing the package alone does not enable them. Do not run first-time profile initialization against an existing profile.

## Original superagent setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
