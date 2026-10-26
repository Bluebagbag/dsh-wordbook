#!/usr/bin/env bash
# 把本仓库的三个插件装进一个 DSH profile。
# 用法：
#   ./install.sh
#   DSH_HOME=~/.dsh DSH_PROFILE=~/.dsh/profiles/web ./install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-$DSH_HOME/profiles/web}"

if [ ! -d "$PROFILE" ]; then
  echo "找不到 profile: $PROFILE" >&2
  echo "先确认 DSH 已经初始化过，或用 DSH_PROFILE 指定路径。" >&2
  exit 1
fi

mkdir -p "$PROFILE/node_modules"
for pkg in dsh-wordbook dsh-maimemo dsh-reading; do
  ln -sfn "$REPO_DIR/plugins/$pkg" "$PROFILE/node_modules/$pkg"
  echo "link  $PROFILE/node_modules/$pkg"
done

node - "$PROFILE" "$REPO_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const profile = process.argv[2];
const repo = process.argv[3];

// 1) package.json 依赖
const manifestPath = path.join(profile, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.dependencies = manifest.dependencies || {};
for (const pkg of ['dsh-wordbook', 'dsh-maimemo', 'dsh-reading']) {
  manifest.dependencies[pkg] = 'link:' + path.join(repo, 'plugins', pkg);
}
const sorted = {};
for (const key of Object.keys(manifest.dependencies).sort()) sorted[key] = manifest.dependencies[key];
manifest.dependencies = sorted;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('deps  ' + manifestPath);

// 2) cordis.patch.yml 追加 Loader 行（已存在就跳过）
const patchPath = path.join(profile, 'cordis.patch.yml');
let patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '[]\n';
const rows = [
  ['wordbook', 'dsh-wordbook'],
  ['maimemo', 'dsh-maimemo'],
  ['reading-gen', 'dsh-reading'],
];
const missing = rows.filter(([id]) => !new RegExp('^\\s*-\\s*id:\\s*' + id + '\\s*$', 'm').test(patch));
if (missing.length > 0) {
  fs.writeFileSync(patchPath + '.bak-' + Date.now(), patch);
  // 空 profile 的 patch 是 []，不能和后面的列表项并存；先去掉空数组行。
  patch = patch.replace(/^\s*\[\s*\]\s*$/m, '');
  if (patch && !patch.endsWith('\n')) patch += '\n';
  patch += '\n# dsh-wordbook suite\n';
  for (const [id, name] of missing) {
    patch += '- insert:\n    - id: ' + id + '\n      name: ' + name + '\n';
  }
  fs.writeFileSync(patchPath, patch);
  console.log('patch ' + patchPath + ' (+' + missing.length + ')');
} else {
  console.log('patch ' + patchPath + ' (already present)');
}
NODE

# 3) 墨墨 token 模板
mkdir -p "$DSH_HOME/maimemo"
chmod 700 "$DSH_HOME/maimemo" 2>/dev/null || true
CONFIG="$DSH_HOME/maimemo/config.json"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<'JSON'
{
  "baseUrl": "https://open.maimemo.com/open/api/v1",
  "token": ""
}
JSON
  chmod 600 "$CONFIG" 2>/dev/null || true
  echo "config $CONFIG（请填入墨墨 token；不接墨墨就留空）"
else
  echo "config $CONFIG（已存在，不覆盖）"
fi

echo
echo "装好了。刷新一次 DSH 网页；如果宿主半边没出现，重启 dsh 后再刷新。"
