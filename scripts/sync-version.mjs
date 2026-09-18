// package.json의 version을 단일 소스로 삼아 Cargo.toml 버전을 동기화한다.
// tauri.conf.json은 version 필드를 생략했으므로 자동으로 package.json을 따른다.
//
// `npm version` 훅(scripts.version)에서 자동 실행되며,
// 수동 실행도 가능하다: `node scripts/sync-version.mjs`

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (!version) {
  console.error("[sync-version] package.json에 version이 없습니다.");
  process.exit(1);
}

// Cargo.toml의 [package] 섹션 첫 version만 교체
const cargoPath = join(root, "src-tauri", "Cargo.toml");
let cargo = readFileSync(cargoPath, "utf8");
const cargoVersionRe = /^(version\s*=\s*")([^"]*)(")/m;
if (!cargoVersionRe.test(cargo)) {
  console.error("[sync-version] Cargo.toml에서 version 필드를 찾지 못했습니다.");
  process.exit(1);
}
const before = cargo;
cargo = cargo.replace(cargoVersionRe, `$1${version}$3`);
if (cargo !== before) {
  writeFileSync(cargoPath, cargo);
  console.log(`[sync-version] Cargo.toml -> ${version}`);
}

// Cargo.lock에서 이 패키지의 version도 함께 갱신(빌드 시 lock 불일치 방지)
const lockPath = join(root, "src-tauri", "Cargo.lock");
if (existsSync(lockPath)) {
  let lock = readFileSync(lockPath, "utf8");
  const pkgName = pkg.name || "mdv";
  const lockRe = new RegExp(
    `(name\\s*=\\s*"${pkgName}"\\s*\\nversion\\s*=\\s*")([^"]*)(")`,
    "m"
  );
  if (lockRe.test(lock)) {
    const lockBefore = lock;
    lock = lock.replace(lockRe, `$1${version}$3`);
    if (lock !== lockBefore) {
      writeFileSync(lockPath, lock);
      console.log(`[sync-version] Cargo.lock (${pkgName}) -> ${version}`);
    }
  }
}
