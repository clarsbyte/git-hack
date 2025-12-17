import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Read package.json
const packagePath = join(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

// Read manifest.json
const manifestPath = join(rootDir, 'manifest.json');
const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Increment version (semantic versioning: major.minor.patch)
function incrementVersion(version) {
    const parts = version.split('.').map(Number);
    // Increment patch version
    parts[2] = (parts[2] || 0) + 1;
    return parts.join('.');
}

// Update versions
const oldPackageVersion = packageJson.version;
const oldManifestVersion = manifestJson.version;

packageJson.version = incrementVersion(oldPackageVersion);
manifestJson.version = incrementVersion(oldManifestVersion);

// Write back to files
writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 4) + '\n');

// Update version.ts file
const versionTsPath = join(rootDir, 'src', 'version.ts');
const versionTsContent = `// This file is auto-generated during build
// The version is injected from package.json
export const VERSION = '${packageJson.version}';
`;
writeFileSync(versionTsPath, versionTsContent);

console.log(`✅ Version incremented:`);
console.log(`   package.json: ${oldPackageVersion} → ${packageJson.version}`);
console.log(`   manifest.json: ${oldManifestVersion} → ${manifestJson.version}`);
console.log(`   src/version.ts: Updated to ${packageJson.version}`);

