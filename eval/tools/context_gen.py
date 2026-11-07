"""Generation cost by window size for context_audit.py, section 8 (d-f63b-economy-0711, item 4). Stdlib only.

A generation is one main session (not a subagent). Intake — its calls up to the first `lineage.py ack`; outtake — from
the first handoff marker after the last unit of work (commit, push, PR), else from the last marker. A marker is a Write
of a handoff file or a `spawn_session.sh … --handoff` that is not a dry run. Markers count only at a command start:
a mention in a commit message or a grep is not a handoff (review of #105).
"""
import os
import re
import statistics

BANDS = (('≤ 250K', 250_000), ('250–500K', 500_000), ('> 500K', float('inf')))
_START = r'(?:^|[;&|(])[ \t]*(?:[A-Za-z_]\w{0,40}=\S{0,200}[ \t]+){0,4}'
ACK = re.compile(_START + r'(?:\S{0,200}python3?[ \t]+(?:-\S{1,20}[ \t]+){0,3})?\S{0,200}lineage\.py[ \t]+ack\b', re.M)
SPAWN = re.compile(_START + r'(?:(?:ba|z)?sh[ \t]+)?\S{0,200}spawn_session\.sh\b(?![^\n]{0,400}--dry-run)'
                   r'[^\n]{0,400}--handoff', re.M)
BOUNDARY = re.compile(_START + r'(?:git(?:[ \t]+-C[ \t]+\S{1,300})?[ \t]+(?:commit|push)\b|gh[ \t]+pr[ \t]+(?:create|merge)\b)',
                      re.M)


def new_generation():
    return {'max': 0, 'usd': 0.0, 'calls': [], 'intake': None, 'out_from': None, 't0': None, 't1': None,
            'marks': [], 'boundary': -1}


def note_tool(gen, name, inp):
    """Record the intake, a unit of work or a handoff marker of a tool call made in the generation's last call."""
    if not gen['calls']:
        return
    cmd, at = (str(inp.get('command', ''))[:4000] if name == 'Bash' else ''), len(gen['calls']) - 1
    if gen['intake'] is None and ACK.search(cmd):
        gen['intake'] = at
    if BOUNDARY.search(cmd):
        gen['boundary'] = at
    if SPAWN.search(cmd) or name == 'Write' and handoff_file(str(inp.get('file_path', ''))):
        gen['marks'].append(at)


def finish(gen):
    gen['usd'] = sum(gen['calls'])
    gen['life'] = (gen['t1'] - gen['t0']).total_seconds() / 60
    gen['out_from'] = outtake_from(gen['marks'], gen['boundary'])
    return gen


def handoff_file(path):
    low = (path or '').lower()
    return low.endswith('.md') and ('handoff' in os.path.basename(low) or '/handoff/' in low)


def outtake_from(marks, boundary):
    after = [i for i in marks if i > boundary]
    return after[0] if after else (marks[-1] if marks else None)


def handoff_usd(gen):
    """$ of the intake and of the outtake, each call once."""
    calls = gen['calls']
    upto = gen['intake'] + 1 if gen['intake'] is not None else 0
    start = max(gen['out_from'], upto) if gen['out_from'] is not None else len(calls)
    return sum(calls[:upto]) + sum(calls[start:])


def generation_bands(gens):
    """Per band of the largest context: sessions, median life and $ per call, $ in total, handoff share."""
    out = {}
    for name, top in BANDS:
        low = max([b for _, b in BANDS if b < top], default=0)
        rows = [g for g in gens if low < g['max'] <= top and g['usd']]
        if not rows:
            continue
        per_call = [c for g in rows for c in g['calls']]
        handed = [g for g in rows if g['intake'] is not None or g['out_from'] is not None]
        hand_usd = sum(handoff_usd(g) for g in handed)
        handed_usd = sum(g['usd'] for g in handed)
        out[name] = {'sessions': len(rows), 'with_handoff': len(handed), 'usd': round(sum(g['usd'] for g in rows), 2),
                     'life_min': round(statistics.median(g['life'] for g in rows), 1),
                     'call_usd': round(statistics.median(per_call), 3),
                     'handoff_share': round(hand_usd / handed_usd, 3) if handed_usd else None}
    return out
