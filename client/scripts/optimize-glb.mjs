import { readdir, copyFile, unlink, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve('.');
const cliPath = path.join(projectRoot, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');
const publicDir = path.join(projectRoot, 'public');
const textureArtifactPatterns = [
  /^basecolor(_\d+)?\.webp$/i,
  /^normal(_\d+)?\.webp$/i,
  /^metallicroughness(_\d+)?\.webp$/i,
  /^occlusion(_\d+)?\.webp$/i,
  /^diffuse(_\d+)?\.webp$/i,
  /^specular(_\d+)?\.webp$/i,
  /^specularglossiness(_\d+)?\.webp$/i,
];

function hasKtxTool() {
  const result = spawnSync('ktx', ['--version'], { stdio: 'ignore', shell: true });
  return result.status === 0;
}

async function findGlbFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'basis') {
        continue;
      }
      files.push(...(await findGlbFiles(full)));
    } else if (entry.isFile() && full.toLowerCase().endsWith('.glb')) {
      files.push(full);
    }
  }
  return files;
}

async function cleanupArtifacts(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'pers') {
        await rm(full, { recursive: true, force: true });
        continue;
      }
      await cleanupArtifacts(full);
      continue;
    }
    if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.glb.bin')) {
        await rm(full, { force: true });
        continue;
      }
      if (lower.endsWith('.webp')) {
        for (const pattern of textureArtifactPatterns) {
          if (pattern.test(entry.name)) {
            await rm(full, { force: true });
            break;
          }
        }
      }
    }
  }
}

function runOptimize(input, output, textureFormat) {
  const args = [
    cliPath,
    'optimize',
    input,
    output,
    '--compress',
    'meshopt',
    '--texture-compress',
    textureFormat,
  ];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  return result.status === 0;
}

async function main() {
  const textureFormat = hasKtxTool() ? 'ktx2' : 'webp';
  if (textureFormat !== 'ktx2') {
    console.warn('ktx tool not found; falling back to WebP texture compression.');
  }

  await cleanupArtifacts(publicDir);

  const files = await findGlbFiles(publicDir);
  if (files.length === 0) {
    console.log('No .glb files found.');
    return;
  }

  let processed = 0;
  for (const file of files) {
    const temp = file.replace(/\.glb$/i, '.opt.glb');
    const ok = runOptimize(file, temp, textureFormat);
    if (!ok) {
      console.warn(`Failed to optimize: ${file}`);
      continue;
    }
    const info = await stat(temp);
    if (info.size > 0) {
      await copyFile(temp, file);
    }
    await unlink(temp);
    processed += 1;
  }

  console.log(`Optimized ${processed}/${files.length} GLB file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
