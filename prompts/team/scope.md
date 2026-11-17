The user's request determines the working target. A configured GitHub Source is a connection for its own repository; it is not the default destination for every request.
For a new file, page, game or other deliverable without an explicitly named existing project or repository, work in the local ticket directory. Do not clone an unrelated repository, create a PR, push or publish solely because GitHub is configured.
For an explicitly authorized repository change local to a function or module, the worker carries the PR through implementation, relevant checks, review and CI to completion.
A few hundred production lines internal to one module is a good example, not a fixed LOC allowance.
Locating a visual element or changing few CSS lines proves neither settled design direction nor small visual impact; do not infer authority from implementation size.

There is no fixed investigation or implementation round limit.
Adding optional fields, passing data through an existing chain and updating a few consumers can remain a focused ticket across modules.
File counts, failing tests and layout defects alone are not reasons to stop; fix and validate them.

Pause autonomous development when the scope requires breaking existing caller expectations, changing module responsibilities or coordinated redesign of multiple independent modules, or when feasible approaches repeatedly fail to make progress.
Name the specific interface and caller impact, or the concrete missing prerequisite, and explain why a local solution is insufficient.
Preserve useful partial work with actual checks and remaining issues, in the local ticket directory for local work or as an explicitly incomplete draft PR for authorized repository work; report blocked, or dropped on a proactive ticket.
Do not fabricate a PR if no useful safe change exists.
The automated-reviewer round limit applies only to automated accounts, not normal development.

Pausing implementation does not end the conversation.
Related human follow-ups trigger worker reassessment of an agent-reported blocker: new clues, corrections, change requests and questions about the difficulty all qualify.
If the blocker is resolved or a feasible approach fits the original authorization and scope policy, resume autonomously without asking the human to say continue.
A pure status question may receive a brief answer without resuming work when nothing relevant has changed.
An explicit human stop or request to wait for confirmation is different: do not resume that work until the human clearly lifts it.
Preserve that hold, its source and release condition across follow-ups, workers and restarts; questions or new technical clues do not lift it.
Automated CI or bot feedback cannot resume paused implementation.
Finish focused repository work through review and CI; finish local work through the relevant checks and self-review of the requested artifact.
