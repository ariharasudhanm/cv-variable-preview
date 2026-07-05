const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJsonPath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;
const name = packageJson.name;
const vsixName = `${name}-${version}.vsix`;
const stagingDir = path.join(root, '.vsix-build');
const extensionDir = path.join(stagingDir, 'extension');
const vsixPath = path.join(root, vsixName);

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function copyFile(relativePath) {
  const source = path.join(root, relativePath);
  const destination = path.join(extensionDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function ensureFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Required file is missing: ${relativePath}`);
  }
}

childProcess.execFileSync('npm', ['run', 'compile'], {
  cwd: root,
  stdio: 'inherit'
});

ensureFile('out/extension.js');
ensureFile('package.json');
ensureFile('README.md');

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.rmSync(vsixPath, { force: true });

copyFile('package.json');
copyFile('README.md');

const outFiles = fs.readdirSync(path.join(root, 'out')).filter((f) => f.endsWith('.js') || f.endsWith('.js.map'));
for (const file of outFiles) {
  copyFile(path.join('out', file));
}

const imagesDir = path.join(root, 'images');
if (fs.existsSync(imagesDir)) {
  for (const file of fs.readdirSync(imagesDir)) {
    copyFile(path.join('images', file));
  }
}

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(name)}" Version="${escapeXml(version)}" Publisher="${escapeXml(packageJson.publisher)}" />
    <DisplayName>${escapeXml(packageJson.displayName || name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(packageJson.description || '')}</Description>
    <Categories>${escapeXml((packageJson.categories || []).join(','))}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(packageJson.engines.vscode)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="map" ContentType="application/json" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="xml" ContentType="application/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
`;

fs.writeFileSync(path.join(stagingDir, 'extension.vsixmanifest'), manifest);
fs.writeFileSync(path.join(stagingDir, '[Content_Types].xml'), contentTypes);

childProcess.execFileSync('zip', ['-qr', vsixPath, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], {
  cwd: stagingDir,
  stdio: 'inherit'
});

fs.rmSync(stagingDir, { recursive: true, force: true });

console.log(`Created ${vsixName}`);
