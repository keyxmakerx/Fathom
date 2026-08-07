#!/usr/bin/env python3
"""Check every `NN` §S cross-reference in the corpus resolves to a real section.

Nine places in the tree once cited `73` §14, which did not exist -- including two
code comments a work order would have written into shipped source. Everything
agreed with everything else and the destination was missing. This catches that
class mechanically. See 73 §14.1.

Sections are matched as headings (`## 4.7.4 ...`) or as leading table cells
(`| 5.1 | ...`), because the review documents number their findings in tables.
"""
import glob, io, os, re, sys

def docmap():
    m = {}
    for f in sorted(glob.glob('docs/**/*.md', recursive=True)):
        b = os.path.basename(f)
        n = re.match(r'^(\d{2})-', b)
        if n:
            m.setdefault(n.group(1), f)
    return m

def _sections(body):
    """Every section label a heading declares, including ranges like `### 6.1-6.3`."""
    out = set()
    for h in re.findall(r'^#+\s*([\d.]+\d)\s*[\u2013\u2014-]\s*([\d.]+\d)', body, re.M):
        lo, hi = h
        pre = lo.rsplit('.', 1)
        if len(pre) == 2 and hi.startswith(pre[0] + '.'):
            try:
                for i in range(int(pre[1]), int(hi.rsplit('.', 1)[1]) + 1):
                    out.add(f'{pre[0]}.{i}')
            except ValueError:
                pass
    for h in re.findall(r'^#+\s*([\d.]+\d)[\.\s]', body, re.M):
        out.add(h)
    return out

def has_section(body, sec):
    """A citation resolves if it is a heading, a range heading, a leading table
    cell (the review documents number findings in tables), or a numbered list
    item inside its parent section (`78` §5.5 is section 5, item 5)."""
    e = re.escape(sec)
    if sec in _sections(body):
        return True
    if re.search(r'^\|\s*\*?\*?§?' + e + r'\b', body, re.M):
        return True
    if '.' in sec:
        parent, item = sec.rsplit('.', 1)
        m = re.search(r'^#+\s*' + re.escape(parent) + r'[\.\s].*?(?=^#{1,2}\s*\d|\Z)',
                      body, re.M | re.S)
        if m and re.search(r'^' + re.escape(item) + r'\.\s', m.group(0), re.M):
            return True
    return False

def main():
    docs = docmap()
    bodies = {k: io.open(v, encoding='utf-8').read() for k, v in docs.items()}
    targets = sorted(glob.glob('docs/**/*.md', recursive=True)) + ['CLAUDE.md', 'README.md']
    bad, total = [], 0
    for f in targets:
        if not os.path.exists(f):
            continue
        for num, sec in re.findall(r'`(\d{2})`\s*§+\s*([\d.]+\d)', io.open(f, encoding='utf-8').read()):
            total += 1
            if num not in docs:
                bad.append((f, num, sec, 'no such document'))
            elif not has_section(bodies[num], sec):
                bad.append((f, num, sec, os.path.basename(docs[num])))
    print(f'{total} cross-references checked, {len(bad)} unresolved')
    for f, num, sec, why in bad:
        print(f'  {f}: `{num}` §{sec} -> {why}')
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main())
