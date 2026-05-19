// S1 — capture-coverage depth (ts-morph). Map, not plan. For each real
// Effect.context<T>() capture: closure LOC, refs to the captured binding,
// re-provision?, T's declared tag-members vs how many are actually touched
// (over-capture). Answers the precommitment: <20L+unused → refactor-cheap;
// 200L+consumed → load-bearing.
import { Project, SyntaxKind, Node } from "ts-morph";

const proj = new Project({
  tsConfigFilePath: "packages/host-sdk/tsconfig.json",
  skipAddingFilesFromTsConfig: false,
});

type Row = {
  site: string; capturedType: string; declaredMembers: number;
  bindingName: string; closureLOC: number; bindingRefs: number;
  reProvided: boolean; membersTouched: number; overCapture: number;
  verdict: string;
};
const rows: Row[] = [];

for (const sf of proj.getSourceFiles("packages/host-sdk/src/**/*.ts")) {
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    const exprTxt = n.getExpression().getText();
    if (exprTxt !== "Effect.context") return;
    const targ = n.getTypeArguments()[0];
    if (!targ) return;

    const file = sf.getFilePath().replace(/.*\/packages\//, "packages/");
    const line = n.getStartLineNumber();
    const site = `${file}:${line}`;

    // declared members of T. The in-worktree checker collapses cross-package
    // union aliases to a single type, so prefer SYNTACTIC resolution: find
    // the `type Alias = A | B | C` declaration by name and read its union
    // member list. Falls back to checker, then to raw split.
    const resolveAliasMembers = (name: string, depth = 0): string[] => {
      if (depth > 4) return [name];
      for (const s of proj.getSourceFiles()) {
        const ta = s.getTypeAlias(name);
        if (!ta) continue;
        const tn = ta.getTypeNode();
        if (tn && Node.isUnionTypeNode(tn)) {
          return tn.getTypeNodes().flatMap((u) => {
            const ut = u.getText().trim();
            return /^[A-Z][\w]*$/.test(ut) && proj.getSourceFiles().some((x) => x.getTypeAlias(ut))
              ? resolveAliasMembers(ut, depth + 1)
              : [ut];
          });
        }
        return [ta.getTypeNode()?.getText().trim() ?? name];
      }
      return [name];
    };
    const rawT = targ.getText().replace(/\s+/g, " ").trim();
    let members: string[];
    if (rawT.includes("|")) {
      members = rawT.replace(/^\|/, "").split("|").flatMap((s) => {
        const t = s.trim();
        return /^[A-Z][\w]*$/.test(t) ? resolveAliasMembers(t) : [t];
      });
    } else if (/^[A-Z][\w]*$/.test(rawT)) {
      members = resolveAliasMembers(rawT);
    } else {
      members = [rawT];
    }
    members = [...new Set(members.map((m) => m.replace(/<.*/, "").trim()).filter(Boolean))];

    // the binding: `const X = yield* Effect.context<T>()` or Effect.map form
    let bindingName = "";
    const varDecl = n.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (varDecl && varDecl.getInitializer()?.getText().includes("Effect.context"))
      bindingName = varDecl.getNameNode().getText();

    // enclosing closure (arrow / function / generator body)
    const fn =
      n.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ??
      n.getFirstAncestorByKind(SyntaxKind.FunctionExpression) ??
      n.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
    const closureLOC = fn
      ? fn.getEndLineNumber() - fn.getStartLineNumber() + 1
      : 0;

    // refs to the binding within the file; re-provision detection
    let bindingRefs = 0, reProvided = false, membersTouched = 0;
    if (bindingName && varDecl) {
      const idNode = varDecl.getNameNode();
      if (Node.isIdentifier(idNode)) {
        const refs = idNode.findReferencesAsNodes();
        bindingRefs = refs.length - 1; // minus the declaration
        for (const r of refs) {
          const p = r.getParent();
          if (p && /provide/.test(p.getText().slice(0, 80))) reProvided = true;
        }
      }
      // crude "tags touched": members whose short name appears applied to
      // the binding region (Context.get(binding, Tag) / binding usage scope)
      const scopeTxt = fn ? fn.getText() : sf.getText();
      membersTouched = members.filter((m) => {
        const short = m.replace(/<.*/, "").split(".").pop() ?? m;
        return short.length > 2 && scopeTxt.includes(short);
      }).length;
    }

    const overCapture = Math.max(0, members.length - membersTouched);
    const small = closureLOC < 20;
    const mostUnused = members.length > 0 && membersTouched <= members.length / 2;
    const verdict = small && mostUnused
      ? "cheap-to-eliminate (small + over-captured)"
      : closureLOC >= 200 && !mostUnused
      ? "load-bearing (large + tags consumed)"
      : "moderate (neither extreme — judgment site)";

    rows.push({
      site, capturedType: targ.getText().replace(/\s+/g, " ").slice(0, 60),
      declaredMembers: members.length, bindingName: bindingName || "(non-binding form)",
      closureLOC, bindingRefs, reProvided, membersTouched, overCapture, verdict,
    });
  });
}

rows.sort((a, b) => a.site.localeCompare(b.site));
console.log(JSON.stringify({ analysis: "S1", generated: new Date().toISOString(), rows }, null, 2));
