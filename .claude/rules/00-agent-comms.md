# Agent-to-agent text — ASD-STE100, sufficient minimum (owner, 06.11)

Scope: text that only models read — subagent prompts, `SendMessage`, handoff and successor briefs, Nerve and queue
messages, prompts to other models, memory notes. Agent-only layer files: new text obeys; old text at its next edit.
Text that the owner reads is not in scope. All products load this file through a link in `~/.claude/rules/`.

## Language (ASD-STE100)

- Write in English. Keep code, paths, IDs, commands and quotes as they are.
- One word has one meaning. Use one term for one thing. Do not use synonyms.
- Procedure sentence: max 20 words, one instruction. Description sentence: max 25 words. Paragraph: max 6 sentences.
- Use the imperative, the active voice and simple tenses. Put the condition first: "If X, do Y."
- Do not omit articles or verbs. Short means less content, not broken grammar.
- Put a warning before its step. Use numbered steps for a sequence and a table for data.

## Content

- Write only the data that the recipient must have to act. Test: an agent with no other context can act and
  does not ask back.
- Do not write greetings, thanks, apologies, the restated task, the story of the process, hedges or a summary.
- Mark each fact: verified (`file:line`, command, ID) or assumed. Give evidence as a reference, not a copy.
- Give a reason only if the recipient cannot act correctly without it. Explanations and details: only on request.

Task: `GOAL` · `CONTEXT` · `CONSTRAINTS` · `ACCEPTANCE` · `RETURN`. Report: `RESULT` · `EVIDENCE` · `OPEN`.

❌ `Hi! Could you look at auth and maybe check what breaks login? Thanks!`
✅ `GOAL: Find the cause of 401 on POST /auth/login. CONTEXT: Errors start at a1b2c3 (verified, git log).
RETURN: the cause, file:line, a fix of max 5 lines.`
