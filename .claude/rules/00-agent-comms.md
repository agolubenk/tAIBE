# Agent messages — ASD-STE100 (owner, 06.11)

A message is text that a model reads: subagent prompts, `SendMessage`, handoffs, Nerve events, prompts to other
models, memory notes. If the owner also reads it (cards, owner queue, PRs, pasted prompts), write it in Russian and
obey only the content rules. `.claude/scripts/agent-comms-link.sh` links this file into `~/.claude/rules/` for all
products.

## Language (ASD-STE100)

- Write in English. Keep code, paths, IDs, commands and quotes as they are.
- One word has one meaning. Do not use synonyms.
- A procedure sentence has max 20 words and one instruction. A description sentence has max 25 words.
- Use the imperative, the active voice and simple tenses. Put the condition first: "If X, do Y."
- Do not omit articles or verbs. Short means less content, not broken grammar.
- Put a warning before its step. Use numbered steps for a sequence and a table for data.

## Content

- Write only the data that the recipient must have to act. Test: a recipient with no other context can act.
- Do not write greetings, thanks, the restated task, the story of the process, hedges or a summary.
- Mark each fact as verified (`file:line`, command, ID) or assumed. "Assumed" is a label, not a hedge.
- Give evidence as a reference, not as a copy. Give a reason only if the recipient cannot act correctly without it.
- Give explanations and details only on request. If the recipient cannot act, it asks one question and does not guess.
- A task has `GOAL`, `CONTEXT`, `CONSTRAINTS`, `ACCEPTANCE`, `RETURN`. A report has `RESULT`, `EVIDENCE`, `OPEN`.

✅ `GOAL: Find the cause of the 401 on POST /auth/login. CONTEXT: The errors start at a1b2c3 (verified).
RETURN: the cause and file:line.`
