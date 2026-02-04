const fs = require('node:fs')
const path = require('node:path')

const checks = [
  {
    file: 'backend/main.py',
    required: ['CLAUDE_API_KEY'],
  },
  {
    file: 'README.md',
    required: ['CLAUDE_API_KEY'],
  }
]

let ok = true

for (const check of checks) {
  const filePath = path.resolve(__dirname, check.file)
  const content = fs.readFileSync(filePath, 'utf8')

  for (const required of check.required) {
    if (!content.includes(required)) {
      console.error(`[FAIL] ${check.file} missing ${required}`)
      ok = false
    }
  }

  for (const forbidden of check.forbidden) {
    if (content.includes(forbidden)) {
      console.error(`[FAIL] ${check.file} contains ${forbidden}`)
      ok = false
    }
  }
}

if (ok) {
  console.log('OK: CLAUDE_API_KEY is set and legacy keys are not present.')
  process.exit(0)
}

process.exit(1)
