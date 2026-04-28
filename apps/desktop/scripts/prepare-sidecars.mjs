#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const sidecarManifestPath = join(
  repoRoot,
  "packages",
  "rust_transcription",
  "Cargo.toml",
);

/** Avoid MAX_PATH failures (e.g. whisper-sys + Vulkan under long OneDrive paths). */
function ensureWindowsShortCargoTargetEnv() {
  if (process.platform !== "win32") {
    return;
  }
  if (process.env.CARGO_TARGET_DIR?.trim()) {
    return;
  }

  const root =
    process.env.VOQUILL_CARGO_TARGET_ROOT?.trim() || join(homedir(), ".voquill");
  const dir = join(root, "cargo-target");

  mkdirSync(dir, { recursive: true });
  process.env.CARGO_TARGET_DIR = dir;
}

/** If VULKAN_SDK is unset, pick the newest Vulkan SDK under standard Windows install roots. */
function ensureWindowsVulkanSdkEnv() {
  if (process.platform !== "win32") {
    return;
  }

  const existing = process.env.VULKAN_SDK?.trim();
  if (existing && existsSync(existing)) {
    return;
  }

  const discovered = discoverVulkanSdkRootWindows();
  if (discovered) {
    process.env.VULKAN_SDK = discovered;
    console.log(`[sidecar] Discovered VULKAN_SDK=${discovered}`);
  }
}

function discoverVulkanSdkRootWindows() {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const roots = [join(programFiles, "VulkanSDK"), "C:\\VulkanSDK"];

  const marker = join("Include", "vulkan", "vulkan_core.h");

  /** @type {string[]} */
  const candidates = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      const full = join(root, ent.name);
      if (existsSync(join(full, marker))) {
        candidates.push(full);
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => compareVulkanSdkVersionDesc(basename(b), basename(a)));
  return candidates[0];
}

/** Sort so higher version strings (e.g. 1.4.304.0) sort first; non-numeric names last. */
function compareVulkanSdkVersionDesc(a, b) {
  const va = parseVersionFolderName(a);
  const vb = parseVersionFolderName(b);
  if (!va && !vb) {
    return 0;
  }
  if (!va) {
    return 1;
  }
  if (!vb) {
    return -1;
  }
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da !== db) {
      return da - db;
    }
  }
  return 0;
}

function parseVersionFolderName(name) {
  const parts = name.split(".").map((p) => parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) {
    return null;
  }
  return parts;
}

ensureWindowsShortCargoTargetEnv();
ensureWindowsVulkanSdkEnv();

const cargoTargetDirOverride = process.env.CARGO_TARGET_DIR?.trim() || null;
const rustTargetDir = cargoTargetDirOverride
  ? isAbsolute(cargoTargetDirOverride)
    ? cargoTargetDirOverride
    : resolve(repoRoot, cargoTargetDirOverride)
  : join(repoRoot, "packages", "rust_transcription", "target");
const tauriBinariesDir = join(desktopDir, "src-tauri", "binaries");

const buildTarget =
  process.env.CARGO_BUILD_TARGET?.trim() ||
  process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
  null;
const targetTriple = buildTarget || resolveHostTargetTriple();
const buildProfile =
  process.env.VOQUILL_SIDECAR_PROFILE === "release" ? "release" : "debug";
const requireNativeGpuSidecar =
  process.env.VOQUILL_REQUIRE_GPU_SIDECAR === "true";
const executableSuffix = isWindowsTarget(targetTriple) ? ".exe" : "";

if (!existsSync(sidecarManifestPath)) {
  fail(`Missing sidecar manifest at ${sidecarManifestPath}`);
}

mkdirSync(tauriBinariesDir, { recursive: true });

const cpuSidecarPath = buildAndCopy("rust-transcription-cpu", false);
const gpuBuildState = resolveGpuBuildState(targetTriple);

if (gpuBuildState.canBuildNative) {
  const gpuSidecarPath = buildAndCopy("rust-transcription-gpu", true, {
    allowFailure: !requireNativeGpuSidecar,
  });

  if (!gpuSidecarPath) {
    mirrorCpuSidecarAsGpu(cpuSidecarPath);
  }
} else {
  if (requireNativeGpuSidecar) {
    fail(
      `Native GPU sidecar is required for ${targetTriple}, but unavailable: ${gpuBuildState.reason}`,
    );
  }

  console.warn(
    `[sidecar] Skipping native GPU sidecar build for ${targetTriple}: ${gpuBuildState.reason}`,
  );
  mirrorCpuSidecarAsGpu(cpuSidecarPath);
}

function buildAndCopy(binaryName, gpuEnabled, options = {}) {
  const allowFailure = options.allowFailure === true;
  const cargoArgs = [
    "build",
    "--manifest-path",
    sidecarManifestPath,
    "--bin",
    binaryName,
  ];

  if (buildTarget) {
    cargoArgs.push("--target", buildTarget);
  }

  if (buildProfile === "release") {
    cargoArgs.push("--release");
  }

  if (gpuEnabled) {
    cargoArgs.push(
      "--features",
      resolveGpuCargoFeatures(targetTriple).join(","),
    );
  }

  const buildOk = run("cargo", cargoArgs, repoRoot, { allowFailure });
  if (!buildOk) {
    return null;
  }

  const sourceBinaryPath = join(
    rustTargetDir,
    ...(buildTarget ? [buildTarget] : []),
    buildProfile,
    `${binaryName}${executableSuffix}`,
  );
  const destinationBinaryPath = join(
    tauriBinariesDir,
    `${binaryName}-${targetTriple}${executableSuffix}`,
  );

  if (!existsSync(sourceBinaryPath)) {
    fail(`Expected sidecar binary was not produced: ${sourceBinaryPath}`);
  }

  copyFileSync(sourceBinaryPath, destinationBinaryPath);
  if (!isWindowsTarget(targetTriple)) {
    chmodSync(destinationBinaryPath, 0o755);
  }

  console.log(
    `[sidecar] Prepared ${binaryName} for ${targetTriple}: ${destinationBinaryPath}`,
  );

  return destinationBinaryPath;
}

function mirrorCpuSidecarAsGpu(cpuSidecarPath) {
  const gpuDestinationPath = join(
    tauriBinariesDir,
    `rust-transcription-gpu-${targetTriple}${executableSuffix}`,
  );
  copyFileSync(cpuSidecarPath, gpuDestinationPath);
  if (!isWindowsTarget(targetTriple)) {
    chmodSync(gpuDestinationPath, 0o755);
  }

  console.warn(
    `[sidecar] Using CPU sidecar binary for rust-transcription-gpu on ${targetTriple}: ${gpuDestinationPath}`,
  );
}

function run(command, args, cwd, options = {}) {
  const allowFailure = options.allowFailure === true;
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    const rendered = [command, ...args].join(" ");
    if (allowFailure) {
      console.warn(
        `[sidecar] Command failed (${result.status ?? "unknown"}): ${rendered}`,
      );
      return false;
    }
    fail(`Command failed (${result.status ?? "unknown"}): ${rendered}`);
  }

  return true;
}

function resolveHostTargetTriple() {
  const result = spawnSync("rustc", ["-vV"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  });

  if (result.status === 0 && result.stdout) {
    const hostLine = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("host:"));
    const hostTriple = hostLine?.slice("host:".length).trim();
    if (hostTriple) {
      return hostTriple;
    }
  }

  const fallback = mapPlatformArchToTarget(process.platform, process.arch);
  if (fallback) {
    return fallback;
  }

  fail(
    `Unable to determine Rust host target triple for platform=${process.platform} arch=${process.arch}`,
  );
}

function mapPlatformArchToTarget(platform, arch) {
  if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (platform === "darwin" && arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (platform === "linux" && arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (platform === "linux" && arch === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  if (platform === "win32" && arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "win32" && arch === "arm64") {
    return "aarch64-pc-windows-msvc";
  }
  return null;
}

function isWindowsTarget(target) {
  return target.includes("windows");
}

function isAppleTarget(target) {
  return target.includes("apple-darwin");
}

function supportsNativeGpuSidecar(target) {
  return (
    isAppleTarget(target) ||
    target.includes("windows") ||
    target.includes("linux")
  );
}

function resolveGpuCargoFeatures(target) {
  if (isAppleTarget(target)) {
    return ["gpu", "gpu-metal"];
  }

  if (target.includes("windows") || target.includes("linux")) {
    return ["gpu", "gpu-vulkan"];
  }

  fail(`No GPU cargo feature mapping exists for ${target}`);
}

function resolveGpuBuildState(target) {
  if (!supportsNativeGpuSidecar(target)) {
    return {
      canBuildNative: false,
      reason: "native GPU sidecar builds are unsupported on this platform",
    };
  }

  if (isWindowsTarget(target)) {
    const vulkanSdkDir = process.env.VULKAN_SDK?.trim();
    if (!vulkanSdkDir || !existsSync(vulkanSdkDir)) {
      return {
        canBuildNative: false,
        reason: "VULKAN_SDK is not set to an existing directory",
      };
    }
  }

  if (target.includes("linux")) {
    const pkgCheck = spawnSync("pkg-config", ["--exists", "vulkan"], {
      stdio: "ignore",
    });
    if (pkgCheck.status !== 0) {
      return {
        canBuildNative: false,
        reason:
          "Vulkan development libraries not found (pkg-config --exists vulkan failed)",
      };
    }
  }

  return {
    canBuildNative: true,
    reason: null,
  };
}

// --- Native pill overlays (platform-specific) ---
// macOS pill is linked directly as a Rust library dependency (no sidecar needed).
// Linux GTK pill and Windows pill are built as separate binaries.
if (isLinuxTarget(targetTriple)) {
  buildNativePill("rust_gtk_pill", "voquill-gtk-pill");
}
if (isWindowsTarget(targetTriple)) {
  buildNativePill("rust_windows_pill", "voquill-windows-pill");
}

function buildNativePill(packageDir, binaryName) {
  const pillManifestPath = join(
    repoRoot,
    "packages",
    packageDir,
    "Cargo.toml",
  );

  if (!existsSync(pillManifestPath)) {
    console.warn(`[sidecar] ${binaryName} manifest not found, skipping`);
    return;
  }

  const pillTargetDir = cargoTargetDirOverride
    ? isAbsolute(cargoTargetDirOverride)
      ? cargoTargetDirOverride
      : resolve(repoRoot, cargoTargetDirOverride)
    : join(repoRoot, "packages", packageDir, "target");

  const pillCargoArgs = [
    "build",
    "--manifest-path",
    pillManifestPath,
    "--bin",
    binaryName,
  ];

  if (buildTarget) {
    pillCargoArgs.push("--target", buildTarget);
  }

  if (buildProfile === "release") {
    pillCargoArgs.push("--release");
  }

  const buildOk = run("cargo", pillCargoArgs, repoRoot, {
    allowFailure: true,
  });

  if (!buildOk) {
    console.warn(`[sidecar] ${binaryName} build failed, skipping`);
    return;
  }

  const pillSourcePath = join(
    pillTargetDir,
    ...(buildTarget ? [buildTarget] : []),
    buildProfile,
    `${binaryName}${executableSuffix}`,
  );

  const resourcesDir = join(desktopDir, "src-tauri", "resources");
  mkdirSync(resourcesDir, { recursive: true });
  const pillDestPath = join(resourcesDir, `${binaryName}${executableSuffix}`);

  if (existsSync(pillSourcePath)) {
    copyFileSync(pillSourcePath, pillDestPath);
    if (!isWindowsTarget(targetTriple)) {
      chmodSync(pillDestPath, 0o755);
    }
    console.log(`[sidecar] Prepared ${binaryName}: ${pillDestPath}`);
  } else {
    console.warn(
      `[sidecar] Expected pill binary not produced: ${pillSourcePath}`,
    );
  }
}

function isLinuxTarget(target) {
  return target.includes("linux");
}

function fail(message) {
  console.error(`[sidecar] ${message}`);
  process.exit(1);
}
