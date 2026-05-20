import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import process from "node:process"
import { join } from "node:path"

const DOC_ROOTS = ["README.md", "docs", "features"]
const DOC_EXTENSIONS = new Set([".md", ".yaml"])
const DOC_CONFLICT_MARKER = /<<<<<<<|>>>>>>>|=======/
const DOC_TRAILING_WHITESPACE = /[ \t]$/

const ARCH_EXCLUDE =
  "(^|/)(.*\\.test\\.(ts|tsx|mts)|__tests__|dist|build|coverage)(/|$)"

const archTargets = {
  workspace: {
    paths: ["packages", "apps"],
    output: "docs/dependency-graph.mmd",
    collapse: "^(packages|apps)/[^/]+/src/[^/]+",
  },
  "workspace-detail": {
    paths: ["packages", "apps"],
    output: "docs/dependency-graph-detail.mmd",
  },
  client: {
    paths: ["packages/client/src"],
    output: "docs/dependency-graph-client.mmd",
    collapse: "^packages/client/src/[^/]+",
  },
  protocol: {
    paths: ["packages/protocol/src"],
    output: "docs/dependency-graph-protocol.mmd",
    collapse: "^packages/protocol/src/[^/]+",
  },
  runtime: {
    paths: ["packages/runtime/src"],
    output: "docs/dependency-graph-runtime.mmd",
    collapse: "^packages/runtime/src/[^/]+",
  },
  "runtime-detail": {
    paths: ["packages/runtime/src"],
    output: "docs/dependency-graph-runtime-detail.mmd",
  },
  flamecast: {
    paths: ["apps/flamecast/src"],
    output: "docs/dependency-graph-flamecast.mmd",
    collapse: "^apps/flamecast/src/[^/]+",
  },
  "flamecast-detail": {
    paths: ["apps/flamecast/src"],
    output: "docs/dependency-graph-flamecast-detail.mmd",
  },
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  })

  if (result.error !== undefined) {
    error(result.error.message)
    process.exit(1)
  }

  if (result.status !== 0) process.exit(result.status ?? 1)
}

const collectDocs = (path) => {
  const info = statSync(path)
  if (info.isFile()) {
    if ([...DOC_EXTENSIONS].some(extension => path.endsWith(extension))) {
      return [path]
    }
    return []
  }

  return readdirSync(path)
    .flatMap(entry => collectDocs(join(path, entry)))
}

const checkDocs = () => {
  let failed = false
  for (const file of DOC_ROOTS.flatMap(collectDocs)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (DOC_TRAILING_WHITESPACE.test(line)) {
        error(`${file}:${String(index + 1)}: trailing whitespace`)
        failed = true
      }
      if (DOC_CONFLICT_MARKER.test(line)) {
        error(`${file}:${String(index + 1)}: merge conflict marker`)
        failed = true
      }
    }
  }
  if (failed) process.exit(1)
}

const checkSpecs = () => {
  run("ruby", [
    "-e",
    "require \"yaml\"; ARGV.each { |f| YAML.load_file(f); puts \"ok #{File.basename(f)}\" }",
    ...readdirSync("features", { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry =>
        readdirSync(join("features", entry.name))
          .filter(file => file.endsWith(".feature.yaml"))
          .map(file => join("features", entry.name, file))
      ),
  ])
}

const effectDiagnostics = () => {
  const projects = [
    ...readdirSync("packages").map(name => join("packages", name, "tsconfig.json")),
    ...readdirSync("apps").map(name => join("apps", name, "tsconfig.json")),
  ].filter(path => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })

  let status = 0
  for (const project of projects) {
    log(`== ${project} ==`)
    const result = spawnSync("effect-language-service", [
      "diagnostics",
      "--project",
      project,
      "--format",
      "text",
    ], {
      stdio: "inherit",
      env: process.env,
    })
    if (result.error !== undefined) {
      error(result.error.message)
      process.exit(1)
    }
    if (result.status !== 0) status = result.status ?? 1
  }
  process.exit(status)
}

const depcruise = (target) => {
  const config = archTargets[target]
  if (config === undefined) {
    error(`Unknown architecture target: ${target}`)
    process.exit(1)
  }

  const args = [
    "exec",
    "depcruise",
    "--config",
    ".dependency-cruiser.cjs",
    "--exclude",
    ARCH_EXCLUDE,
    ...config.paths,
    "--output-type",
    "mermaid",
  ]
  if (config.collapse !== undefined) {
    args.push("--collapse", config.collapse)
  }

  const result = spawnSync("pnpm", args, {
    encoding: "utf8",
    env: process.env,
  })
  if (result.error !== undefined) {
    error(result.error.message)
    process.exit(1)
  }
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
  writeFileSync(config.output, result.stdout)
}

const archDeps = (target) => {
  if (target === "all") {
    for (const name of ["workspace", "client", "protocol", "runtime", "flamecast"]) {
      depcruise(name)
    }
    return
  }
  if (target === "detail") {
    for (const name of ["workspace-detail", "runtime-detail", "flamecast-detail"]) {
      depcruise(name)
    }
    return
  }
  depcruise(target)
}

const [group, command, target] = process.argv.slice(2)

if (group === "check" && command === "specs") checkSpecs()
else if (group === "check" && command === "docs") checkDocs()
else if (group === "effect" && command === "diagnostics") effectDiagnostics()
else if (group === "arch" && command === "deps" && target !== undefined) {
  archDeps(target)
} else {
  error(`Unknown tooling command: ${process.argv.slice(2).join(" ")}`)
  process.exit(1)
}
