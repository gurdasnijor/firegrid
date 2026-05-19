// S2 — type-union accretion (ts-morph, syntactic alias resolution: the
// in-worktree checker collapses cross-package union aliases). Resolve each
// named substrate union to its concrete tag set, pairwise Jaccard, count
// function-signature references. Precommitment: high overlap (>70%) →
// accreting to one tier (toy models one union); low → distinct tiers.
import { Project, Node } from "ts-morph";

const proj = new Project({
  tsConfigFilePath: "packages/host-sdk/tsconfig.json",
  skipAddingFilesFromTsConfig: false,
});

const UNIONS = [
  "HostRuntimeContextExecutionEnv",
  "RuntimeContextWorkflowExecutionEnv",
  "RuntimeContextSessionAdapterRequirements",
  "ToolCallHostEnvironment",
  "RuntimeToolUseExecutorHostEnvironment",
];

const resolve = (name: string, depth = 0): string[] => {
  if (depth > 5) return [name];
  for (const s of proj.getSourceFiles()) {
    const ta = s.getTypeAlias(name);
    if (!ta) continue;
    const tn = ta.getTypeNode();
    if (tn && Node.isUnionTypeNode(tn)) {
      return tn.getTypeNodes().flatMap((u) => {
        const ut = u.getText().replace(/<.*/, "").trim();
        return /^[A-Z][\w]*$/.test(ut) && proj.getSourceFiles().some((x) => x.getTypeAlias(ut))
          ? resolve(ut, depth + 1) : [ut];
      });
    }
    return [tn?.getText().replace(/<.*/, "").trim() ?? name];
  }
  return [name]; // leaf tag (no alias decl found = concrete tag)
};

const sets: Record<string, string[]> = {};
for (const u of UNIONS) sets[u] = [...new Set(resolve(u))].sort();

// signature reference count: identifier usages of the alias in a type
// position of a function/method signature.
const sigRefs: Record<string, number> = {};
for (const u of UNIONS) {
  let c = 0;
  for (const s of proj.getSourceFiles("packages/**/*.ts")) {
    for (const id of s.getDescendantsOfKind(/* Identifier */ 80 as any)) {
      if (id.getText() !== u) continue;
      const a = id.getFirstAncestor((p) =>
        Node.isFunctionDeclaration(p) || Node.isMethodSignature(p) ||
        Node.isArrowFunction(p) || Node.isFunctionTypeNode(p) ||
        Node.isPropertySignature(p));
      if (a) c++;
    }
  }
  sigRefs[u] = c;
}

const jac = (a: string[], b: string[]) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 0 : +(inter / uni).toFixed(2);
};

const matrix: Record<string, Record<string, number>> = {};
for (const a of UNIONS) {
  matrix[a] = {};
  for (const b of UNIONS) matrix[a][b] = jac(sets[a], sets[b]);
}
const flagged = [];
for (let i = 0; i < UNIONS.length; i++)
  for (let j = i + 1; j < UNIONS.length; j++)
    if (matrix[UNIONS[i]][UNIONS[j]] > 0.7)
      flagged.push([UNIONS[i], UNIONS[j], matrix[UNIONS[i]][UNIONS[j]]]);

console.log(JSON.stringify({
  analysis: "S2", generated: new Date().toISOString(),
  members: Object.fromEntries(UNIONS.map((u) => [u, { size: sets[u].length, tags: sets[u], sigRefs: sigRefs[u] }])),
  jaccard: matrix, flagged_over_70: flagged,
}, null, 2));
