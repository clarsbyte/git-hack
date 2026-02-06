import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const packageJsonPath = path.join(root, 'package.json')
const manifestPath = path.join(root, 'manifest.json')
const versionTsPath = path.join(root, 'src', 'version.ts')

const parseSemver = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

const formatSemver = ({ major, minor, patch }) => `${major}.${minor}.${patch}`

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const current = parseSemver(packageJson.version || '0.0.0')
if (!current) {
  throw new Error(`Invalid package.json version: ${packageJson.version}`)
}

const next = { ...current, patch: current.patch + 1 }
const nextVersion = formatSemver(next)
const previousVersion = formatSemver(current)

packageJson.version = nextVersion
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.version = nextVersion
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`)

const versionTs = `// This file is auto-generated during build
// The version is injected from package.json
export const VERSION = '${nextVersion}';
export const PREVIOUS_VERSION = '${previousVersion}';
`
fs.writeFileSync(versionTsPath, versionTs)

console.log(`[version] bumped ${current.major}.${current.minor}.${current.patch} -> ${nextVersion}`)
