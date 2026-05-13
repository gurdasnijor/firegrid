export const flamecastToyCreatedBy = "flamecast-toy"

export const flamecastToyAgentSource = `
import { createInterface } from "node:readline"

const words = (value) => value.trim().length === 0
  ? 0
  : value.trim().split(/\\s+/).length

const reply = (prompt) => {
  const compact = prompt.trim().replace(/\\s+/g, " ")
  const reversed = compact.split(/\\s+/).filter(Boolean).reverse().join(" ")
  return compact.length === 0
    ? "Flamecast toy agent received an empty prompt."
    : \`Flamecast toy agent heard "\${compact}" and echoed it backward: \${reversed}.\`
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of rl) {
  console.log(JSON.stringify({
    type: "assistant_message",
    text: reply(line),
    prompt: line,
    wordCount: words(line),
  }))
  process.exit(0)
}
`.trim()
