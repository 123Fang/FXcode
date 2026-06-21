import { $ } from "bun"

const md = await Bun.file("./report.md").text()

// Basic markdown to HTML with print-friendly CSS
const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>OpenCode Core 代码架构分析报告</title>
<style>
  @page { margin: 25mm 20mm; size: A4; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 12px;
    line-height: 1.7;
    color: #1a1a1a;
    max-width: 820px;
    margin: 0 auto;
    padding: 20px;
  }
  h1 { font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 8px; margin-top: 0; }
  h2 { font-size: 18px; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 28px; color: #222; }
  h3 { font-size: 14px; margin-top: 20px; color: #333; }
  h4 { font-size: 12px; margin-top: 16px; color: #444; }
  hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
  code {
    background: #f4f4f4;
    padding: 2px 5px;
    border-radius: 3px;
    font-family: "SF Mono", "Fira Code", "Menlo", monospace;
    font-size: 11px;
  }
  pre {
    background: #f8f8f8;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 14px 16px;
    overflow-x: auto;
    font-family: "SF Mono", "Fira Code", "Menlo", monospace;
    font-size: 11px;
    line-height: 1.5;
  }
  pre code { background: none; padding: 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
    font-size: 11px;
  }
  th, td {
    border: 1px solid #ddd;
    padding: 8px 10px;
    text-align: left;
  }
  th { background: #f5f5f5; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  strong { color: #111; }
  p { margin: 8px 0; }
  ul, ol { padding-left: 24px; }
  li { margin: 3px 0; }
  blockquote {
    border-left: 3px solid #ddd;
    margin: 12px 0;
    padding: 4px 16px;
    color: #555;
    background: #fafafa;
    border-radius: 0 4px 4px 0;
  }
  .page-break { page-break-before: always; }
</style>
</head>
<body>
${renderMarkdown(md)}
</body>
</html>`

await Bun.write("./report.html", html)
console.log("HTML generated: report.html")

// Convert to PDF with Chrome headless
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const htmlPath = new URL("./report.html", import.meta.url).pathname
const pdfPath = new URL("./report.pdf", import.meta.url).pathname

const proc = Bun.spawn([chrome,
  "--headless",
  "--disable-gpu",
  "--no-pdf-header-footer",
  `--print-to-pdf=${pdfPath}`,
  htmlPath,
], { stdout: "inherit", stderr: "inherit" })

await proc.exited
console.log("PDF generated: report.pdf")

// Cleanup temp HTML
await $`rm -f ./report.html`

function renderMarkdown(md: string): string {
  let out = ""
  const lines = md.split("\n")
  let inCodeBlock = false
  let inTable = false
  let tableRows: string[] = []
  let inList = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Code block
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        out += "</code></pre>\n"
        inCodeBlock = false
      } else {
        out += `<pre><code>`
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) {
      out += escapeHtml(line) + "\n"
      continue
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      closeList()
      out += "<hr>\n"
      continue
    }

    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (hMatch) {
      closeList()
      const level = hMatch[1].length
      out += `<h${level}>${hMatch[2]}</h${level}>\n`
      continue
    }

    // Table header separator
    if (line.match(/^\|[\s\-:|]+\|$/)) {
      inTable = true
      continue
    }

    // Table row
    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line.split("|").slice(1, -1).map(c => c.trim())
      if (inTable && tableRows.length === 0) {
        // This is header (we missed it before separator)
        tableRows.push(`<tr>${cells.map(c => `<th>${c}</th>`).join("")}</tr>`)
      } else {
        const tag = tableRows.length === 0 ? "th" : "td"
        tableRows.push(`<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join("")}</tr>`)
      }
      continue
    } else if (tableRows.length > 0) {
      out += `<table>\n${tableRows.join("\n")}\n</table>\n`
      tableRows = []
      inTable = false
    }

    // Bold
    let processed = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Inline code
    processed = processed.replace(/`([^`]+)`/g, "<code>$1</code>")

    // Empty line
    if (line.trim() === "") {
      closeList()
      out += "\n"
      continue
    }

    // Unordered list
    if (line.match(/^\s*[-*]\s+/)) {
      if (!inList) { out += "<ul>\n"; inList = true }
      out += `<li>${processed.replace(/^\s*[-*]\s+/, "")}</li>\n`
      continue
    }

    // Ordered list
    if (line.match(/^\s*\d+\.\s+/)) {
      if (!inList) { out += "<ol>\n"; inList = true }
      out += `<li>${processed.replace(/^\s*\d+\.\s+/, "")}</li>\n`
      continue
    }

    closeList()

    // Blockquote
    if (line.startsWith("> ")) {
      out += `<blockquote>${processed.replace(/^>\s*/, "")}</blockquote>\n`
      continue
    }

    // Regular paragraph
    if (line.trim()) {
      out += `<p>${processed}</p>\n`
    }
  }

  closeList()

  function closeList() {
    if (inList) {
      out += (out.endsWith("<ul>\n") ? "ul" : out.endsWith("<ol>\n") ? "ol" : "") + ">\n"
      inList = false
    }
  }

  return out
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
