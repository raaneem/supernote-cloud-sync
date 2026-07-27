# Public architecture decisions

This directory holds durable technical decisions that contributors need in order
to change the public code safely. It starts empty because private development
records are intentionally not part of the public repository.

Add a decision record when a change establishes or replaces a lasting constraint
on a public interface, security boundary, persisted data format, platform
contract, or major module boundary. Routine implementation choices do not need
one.

Name records `NNNN-short-title.md`, using the next four-digit number, and
include:

- **Status:** Proposed, Accepted, Superseded, or Rejected
- **Context:** the forces and constraints behind the decision
- **Decision:** the chosen rule
- **Consequences:** benefits, costs, and follow-up work
- **Supersedes:** a relative link when replacing an earlier decision

Do not rewrite accepted history. Add a new record and mark the old one
Superseded. Link the relevant GitHub issue and pull request in the record.
