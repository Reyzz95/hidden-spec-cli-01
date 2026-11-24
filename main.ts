// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileLines {
  lines: string[];
  crlf: boolean;
  finalNewline: boolean;
}

function parseFileLines(text: string): FileLines {
  if (text === '') return { lines: [], crlf: false, finalNewline: false };
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const rawLines = text.split(br);
  const finalNewline = text.endsWith(br);
  if (finalNewline && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  return { lines: rawLines, crlf, finalNewline };
}

function serializeFileLines(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  const br = fl.crlf ? '\r\n' : '\n';
  return fl.lines.join(br) + (fl.finalNewline ? br : '');
}

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  if (tier === 2) return a.trim() === b.trim();
  return false;
}

function findOccurrences(fileLines: string[], oldLines: string[], tier: number): number[] {
  const result: number[] = [];
  if (oldLines.length === 0) return result;
  if (fileLines.length < oldLines.length) return result;
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!matchLine(fileLines[i + j]!, oldLines[j]!, tier)) {
        match = false;
        break;
      }
    }
    if (match) result.push(i);
  }
  return result;
}

function findOldLines(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; indices: number[] } {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const indices = findOccurrences(fileLines, oldLines, tier);
    if (indices.length > 0) {
      return { tier, indices };
    }
  }
  return { tier: -1, indices: [] };
}

function getIndentation(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}

function formatNewLines(nLines: string[], tier: number, firstMatchedLine: string, firstOldLine: string): string[] {
  if (tier !== 2) return [...nLines];
  const F = getIndentation(firstMatchedLine);
  const P = getIndentation(firstOldLine);
  return nLines.map((l) => {
    if (l === '' || blank(l)) return l;
    if (P !== '' && l.startsWith(P)) {
      return F + l.slice(P.length);
    }
    return l;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------
// Section 6: Unified Diffs
// ---------------------------------------------------------
interface UnifiedHunk {
  aStart: number;
  lines: { op: ' ' | '-' | '+' | '\\'; text: string }[];
  noNewline: boolean;
}

function parseUnifiedPath(s: string): string | null {
  const parts = s.trim().split('\t');
  let p = parts[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) {
    p = p.slice(2);
  }
  return p;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: { oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: UnifiedHunk[] }[] = [];
  let curSection: { oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: UnifiedHunk[] } | null = null;
  let curHunk: UnifiedHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const match = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (!match) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (curSection !== null) {
        if (curHunk !== null) {
          curSection.hunks.push(curHunk);
          curHunk = null;
        }
        sections.push(curSection);
      }
      curHunk = null;
      curSection = {
        oldPath: match[1]!,
        newPath: match[2]!,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      continue;
    }

    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (curSection !== null && curSection.hunks.length === 0 && curHunk === null && curSection.oldPath !== null) {
        sections.push(curSection);
        curSection = null;
      }
      if (curSection === null) {
        curSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      }
      if (curHunk !== null) {
        curSection.hunks.push(curHunk);
        curHunk = null;
      }
      curSection.oldPath = parseUnifiedPath(l.slice(4));
      i++;
      curSection.newPath = parseUnifiedPath(lines[i]!.slice(4));
      continue;
    }

    if (l.startsWith('rename from ')) {
      if (curSection === null) curSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      curSection.oldPath = l.slice(12).trim();
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (curSection === null) curSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      curSection.newPath = l.slice(10).trim();
      continue;
    }
    if (l.startsWith('new file mode')) {
      if (curSection === null) curSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      curSection.isCreate = true;
      curSection.oldPath = null;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      if (curSection === null) curSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      curSection.isDelete = true;
      curSection.newPath = null;
      continue;
    }

    if (l.startsWith('@@ ')) {
      if (curSection === null) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const hunkMatch = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!hunkMatch) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (curHunk !== null) {
        curSection.hunks.push(curHunk);
      }
      curHunk = {
        aStart: parseInt(hunkMatch[1]!, 10),
        lines: [],
        noNewline: false,
      };
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
          i--;
          break;
        }
        if (bl.startsWith('@@')) {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          const op = bl === '' ? ' ' : (bl[0] as ' ' | '-' | '+');
          const text = bl === '' ? '' : bl.slice(1);
          curHunk.lines.push({ op, text });
          i++;
        } else if (bl.startsWith('\\')) {
          if (curHunk.lines.length > 0) {
            curHunk.noNewline = true;
          }
          i++;
        } else {
          i--;
          break;
        }
      }
      while (curHunk.lines.length > 0 && curHunk.lines[curHunk.lines.length - 1]!.op === ' ' && curHunk.lines[curHunk.lines.length - 1]!.text === '') {
        curHunk.lines.pop();
      }
      curSection.hunks.push(curHunk);
      curHunk = null;
      continue;
    }

    if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  if (curSection !== null) {
    if (curHunk !== null) {
      curSection.hunks.push(curHunk);
    }
    sections.push(curSection);
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    const isCreate = sec.isCreate || sec.oldPath === null;
    const isDelete = sec.isDelete || sec.newPath === null;
    const isMove = sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath && !isCreate && !isDelete;
    const path = isCreate ? sec.newPath! : isDelete ? sec.oldPath! : isMove ? sec.oldPath! : (sec.newPath ?? sec.oldPath!);

    edits.push((tree, strict) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (isMove && sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);

      if (isCreate) {
        if (sec.newPath === null) throw new Fail('missing', path);
        if (tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
        const newFileLines: string[] = [];
        let finalNL = true;
        for (const h of sec.hunks) {
          for (const line of h.lines) {
            if (line.op === '+' || line.op === ' ') {
              newFileLines.push(line.text);
            }
          }
          if (h.noNewline) finalNL = false;
        }
        tree.now.set(sec.newPath, newFileLines.length === 0 ? '' : newFileLines.join('\n') + (finalNL ? '\n' : ''));
        return;
      }

      if (isDelete) {
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
        return;
      }

      // Normal or move change
      const beforeText = tree.get(path);
      if (beforeText === null) throw new Fail('missing', path);
      const fl = parseFileLines(beforeText);
      let currentLines = [...fl.lines];
      let d = 0;
      let lastNoNewline = !fl.finalNewline;

      for (const h of sec.hunks) {
        const oLines: string[] = [];
        for (const line of h.lines) {
          if (line.op === ' ' || line.op === '-') {
            oLines.push(line.text);
          }
        }

        if (oLines.length > 0) {
          const { tier, indices } = findOldLines(currentLines, oLines, strict);
          if (indices.length === 0) throw new Fail('no-match', path);
          const targetPos = h.aStart - 1 + d;
          let bestIdx = indices[0]!;
          let minDist = Math.abs(bestIdx - targetPos);
          for (let idx = 1; idx < indices.length; idx++) {
            const dist = Math.abs(indices[idx]! - targetPos);
            if (dist < minDist) {
              minDist = dist;
              bestIdx = indices[idx]!;
            }
          }
          const firstMatched = currentLines[bestIdx]!;
          const firstOld = oLines[0]!;

          let fileLineIdx = bestIdx;
          const mappedN: string[] = [];
          for (const hl of h.lines) {
            if (hl.op === ' ') {
              mappedN.push(currentLines[fileLineIdx]!);
              fileLineIdx++;
            } else if (hl.op === '-') {
              fileLineIdx++;
            } else if (hl.op === '+') {
              mappedN.push(hl.text);
            }
          }
          const formattedMappedN = formatNewLines(mappedN, tier, firstMatched, firstOld);
          currentLines.splice(bestIdx, oLines.length, ...formattedMappedN);
          d += formattedMappedN.length - oLines.length;
        } else {
          let insertPos = h.aStart + d;
          if (insertPos < 0) insertPos = 0;
          if (insertPos > currentLines.length) insertPos = currentLines.length;
          const nLines: string[] = h.lines.filter((l) => l.op === '+').map((l) => l.text);
          currentLines.splice(insertPos, 0, ...nLines);
          d += nLines.length;
        }
        if (h.noNewline) lastNoNewline = true;
      }

      const outFl: FileLines = {
        lines: currentLines,
        crlf: fl.crlf,
        finalNewline: !lastNoNewline,
      };
      const targetP = isMove ? sec.newPath! : path;
      if (isMove && tree.get(sec.newPath!) !== null) throw new Fail('exists', sec.newPath!);
      tree.now.set(targetP, serializeFileLines(outFl));
      if (isMove) {
        tree.now.set(path, null);
        tree.moves.set(targetP, path);
      }
    });
  }

  return edits;
}

// ---------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------
interface SearchReplaceBlock {
  path: string | null;
  oldLines: string[];
  newLines: string[];
  searchLineNo: number;
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let currentPath: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const trimmed = l.trim();
    if (trimmed === '<<<<<<< SEARCH') {
      const searchLineNo = i + 1;
      let foundPath: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const pj = lines[j]!.trim();
        if (pj === '>>>>>>> REPLACE') break;
        if (!blank(pj) && !pj.startsWith('```')) {
          foundPath = pj;
          break;
        }
      }
      if (foundPath === null) {
        foundPath = currentPath;
      }
      if (foundPath === null) {
        throw new Exit2(`error: parse ${searchLineNo}`);
      }
      currentPath = foundPath;

      i++;
      const oldLines: string[] = [];
      let foundEquals = false;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.trim() === '=======') {
          foundEquals = true;
          break;
        }
        oldLines.push(bl);
        i++;
      }
      if (!foundEquals) {
        throw new Exit2(`error: parse ${searchLineNo}`);
      }

      i++;
      const newLines: string[] = [];
      let foundReplace = false;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.trim() === '>>>>>>> REPLACE') {
          foundReplace = true;
          break;
        }
        newLines.push(bl);
        i++;
      }
      if (!foundReplace) {
        throw new Exit2(`error: parse ${searchLineNo}`);
      }

      blocks.push({
        path: currentPath,
        oldLines,
        newLines,
        searchLineNo,
      });
    }
  }

  const edits: Edit[] = [];
  for (const b of blocks) {
    const path = b.path!;
    edits.push((tree, strict) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (b.oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }

      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const fl = parseFileLines(before);
      const { tier, indices } = findOldLines(fl.lines, b.oldLines, strict);
      if (indices.length === 0) throw new Fail('no-match', path);
      if (indices.length > 1) throw new Fail('ambiguous', path);

      const idx = indices[0]!;
      const firstMatched = fl.lines[idx]!;
      const formattedN = formatNewLines(b.newLines, tier, firstMatched, b.oldLines[0]!);
      fl.lines.splice(idx, b.oldLines.length, ...formattedN);
      tree.now.set(path, serializeFileLines(fl));
    });
  }

  return edits;
}

// ---------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------
interface V4AChunk {
  anchor: string | null;
  lines: { op: ' ' | '-' | '+'; text: string }[];
  isEnd: boolean;
}

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  movePath: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

function v4aEdits(lines: string[]): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0 || lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank >= 0 ? firstNonBlank + 1 : 1}`);
  }
  const lastNonBlank = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!blank(lines[i]!)) return i;
    }
    return -1;
  })();
  if (lastNonBlank < 0 || lines[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lastNonBlank >= 0 ? lastNonBlank + 2 : lines.length + 1}`);
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;
  while (i < lastNonBlank) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const trimmed = l.trim();
    if (trimmed.startsWith('*** Add File:')) {
      const path = trimmed.slice(13).trim();
      i++;
      const fileLines: string[] = [];
      while (i < lastNonBlank) {
        const bl = lines[i]!;
        if (blank(bl)) {
          let nextNB = i;
          while (nextNB < lastNonBlank && blank(lines[nextNB]!)) nextNB++;
          if (nextNB < lastNonBlank && (lines[nextNB]!.trim().startsWith('*** Add File:') || lines[nextNB]!.trim().startsWith('*** Delete File:') || lines[nextNB]!.trim().startsWith('*** Update File:'))) {
            break;
          }
        }
        if (bl.trim().startsWith('*** ')) break;
        if (bl.startsWith('+')) {
          fileLines.push(bl.slice(1));
        } else if (bl === '') {
          fileLines.push('');
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i++;
      }
      sections.push({ type: 'add', path, movePath: null, lines: fileLines, chunks: [] });
      continue;
    }

    if (trimmed.startsWith('*** Delete File:')) {
      const path = trimmed.slice(16).trim();
      sections.push({ type: 'delete', path, movePath: null, lines: [], chunks: [] });
      i++;
      continue;
    }

    if (trimmed.startsWith('*** Update File:')) {
      const path = trimmed.slice(16).trim();
      i++;
      let movePath: string | null = null;
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;

      while (i < lastNonBlank) {
        const bl = lines[i]!;
        if (blank(bl)) {
          let nextNB = i;
          while (nextNB < lastNonBlank && blank(lines[nextNB]!)) nextNB++;
          if (nextNB < lastNonBlank && (lines[nextNB]!.trim().startsWith('*** Add File:') || lines[nextNB]!.trim().startsWith('*** Delete File:') || lines[nextNB]!.trim().startsWith('*** Update File:'))) {
            break;
          }
        }
        const bTrim = bl.trim();
        if (bTrim.startsWith('*** ')) {
          if (bTrim.startsWith('*** Move to:')) {
            movePath = bTrim.slice(12).trim();
            i++;
            continue;
          }
          if (bTrim === '*** End of File') {
            if (curChunk !== null) {
              curChunk.isEnd = true;
              chunks.push(curChunk);
              curChunk = null;
            }
            i++;
            continue;
          }
          break;
        }

        if (bTrim.startsWith('@@')) {
          if (curChunk !== null) {
            chunks.push(curChunk);
          }
          const anchor = bTrim.slice(2).trim() || null;
          curChunk = { anchor, lines: [], isEnd: false };
          i++;
          continue;
        }

        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (curChunk === null) {
            curChunk = { anchor: null, lines: [], isEnd: false };
          }
          const op = bl === '' ? ' ' : (bl[0] as ' ' | '-' | '+');
          const text = bl === '' ? '' : bl.slice(1);
          curChunk.lines.push({ op, text });
          i++;
          continue;
        }

        throw new Exit2(`error: parse ${i + 1}`);
      }

      if (curChunk !== null) {
        chunks.push(curChunk);
      }
      if (chunks.length === 0 && movePath === null) {
        throw new Exit2(`error: parse ${i}`);
      }

      sections.push({ type: 'update', path, movePath, lines: [], chunks });
      continue;
    }

    throw new Exit2(`error: parse ${i + 1}`);
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    edits.push((tree, strict) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.movePath !== null && !safe(sec.movePath)) throw new Fail('unsafe', sec.movePath);

      if (sec.type === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.lines.join('\n') + '\n');
        return;
      }

      if (sec.type === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }

      const oldP = sec.path;
      const newP = sec.movePath ?? oldP;
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (sec.movePath !== null && tree.get(sec.movePath) !== null) throw new Fail('exists', sec.movePath);

      const fl = parseFileLines(before);
      let currentLines = [...fl.lines];
      let cursor = 0;

      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          let foundAnchorIdx = -1;
          for (let idx = cursor; idx < currentLines.length; idx++) {
            const { tier } = findOldLines([currentLines[idx]!], [chunk.anchor], strict);
            if (tier >= 0) {
              foundAnchorIdx = idx;
              break;
            }
          }
          if (foundAnchorIdx < 0) throw new Fail('no-match', oldP);
          cursor = foundAnchorIdx + 1;
        }

        const oLines: string[] = [];
        const nLines: string[] = [];
        for (const line of chunk.lines) {
          if (line.op === ' ' || line.op === '-') oLines.push(line.text);
          if (line.op === ' ' || line.op === '+') nLines.push(line.text);
        }

        if (oLines.length > 0) {
          const subLines = currentLines.slice(cursor);
          const { tier, indices } = findOldLines(subLines, oLines, strict);
          if (indices.length === 0) throw new Fail('no-match', oldP);
          let matchIdx = cursor + indices[0]!;
          if (chunk.isEnd) {
            const valid = indices.find((idx) => cursor + idx + oLines.length === currentLines.length);
            if (valid === undefined) throw new Fail('no-match', oldP);
            matchIdx = cursor + valid;
          }
          const firstMatched = currentLines[matchIdx]!;
          let fileLineIdx = matchIdx;
          const mappedN: string[] = [];
          for (const hl of chunk.lines) {
            if (hl.op === ' ') {
              mappedN.push(currentLines[fileLineIdx]!);
              fileLineIdx++;
            } else if (hl.op === '-') {
              fileLineIdx++;
            } else if (hl.op === '+') {
              mappedN.push(hl.text);
            }
          }
          const formattedMappedN = formatNewLines(mappedN, tier, firstMatched, oLines[0]!);
          currentLines.splice(matchIdx, oLines.length, ...formattedMappedN);
          cursor = matchIdx + formattedMappedN.length;
        } else {
          let insertPos = cursor;
          if (chunk.isEnd) insertPos = currentLines.length;
          currentLines.splice(insertPos, 0, ...nLines);
          cursor = insertPos + nLines.length;
        }
      }

      fl.lines = currentLines;
      const resText = serializeFileLines(fl);
      tree.now.set(newP, resText);
      if (sec.movePath !== null) {
        tree.now.set(oldP, null);
        tree.moves.set(newP, oldP);
      }
    });
  }

  return edits;
}

// ---------------------------------------------------------
// Main CLI Run Logic
// ---------------------------------------------------------
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else if (kind === 'v4a') edits = v4aEdits(lines);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  
  const changedPaths = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const moveMap = tree.moves;
  const handledPaths = new Set<string>();
  const rows: { sortPath: string; line: string }[] = [];

  for (const p of changedPaths) {
    if (handledPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;

    if (moveMap.has(p)) {
      const oldP = moveMap.get(p)!;
      if (tree.original(oldP) !== null && tree.now.get(oldP) === null) {
        handledPaths.add(oldP);
        handledPaths.add(p);
        rows.push({
          sortPath: p,
          line: `R ${oldP} -> ${p}`,
        });
        if (!check) {
          rmSync(oldP, { force: true });
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
        continue;
      }
    }

    let isMovePair = false;
    if (was !== null && now === null) {
      for (const [newP, oldP] of moveMap.entries()) {
        if (oldP === p && tree.now.get(newP) !== null) {
          handledPaths.add(oldP);
          handledPaths.add(newP);
          rows.push({
            sortPath: newP,
            line: `R ${oldP} -> ${newP}`,
          });
          isMovePair = true;
          if (!check) {
            rmSync(oldP, { force: true });
          }
          break;
        }
      }
    }
    if (isMovePair) continue;

    handledPaths.add(p);
    const code = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({
      sortPath: p,
      line: `${code} ${p}`,
    });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortPath), Buffer.from(b.sortPath)));
  const lineRows = rows.map((r) => r.line);
  return { code: 0, out: [...lineRows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
