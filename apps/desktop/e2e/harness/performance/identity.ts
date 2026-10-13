import os from "node:os";
import type { LaunchedApp } from "../launch";
import {
  captureBuildIdentity as capture,
  type CapturedBuildIdentity,
} from "../../../scripts/performance-build-identity.mjs";

export type BuildIdentity = CapturedBuildIdentity;

export interface EnvironmentIdentity {
  readonly electron: string | null;
  readonly chrome: string | null;
  readonly os: {
    readonly platform: string;
    readonly release: string;
    readonly arch: string;
  };
  readonly runner_class: "ci" | "local";
  readonly cpu: {
    readonly model: string;
    readonly logical_cores: number;
  };
  readonly memory: {
    readonly total_bytes: number;
    readonly free_bytes: number;
  };
  readonly gpu: {
    readonly info_status: "available" | "unavailable";
    readonly devices: readonly {
      readonly vendor_id: number | null;
      readonly device_id: number | null;
      readonly name: string | null;
      readonly active: boolean | null;
    }[];
    readonly feature_status: Readonly<Record<string, string | null>>;
  };
  readonly visible: boolean | null;
  readonly focused: boolean | null;
  readonly window_css_px: { readonly width: number; readonly height: number } | null;
  readonly window_content_dip_px: { readonly width: number; readonly height: number } | null;
  readonly device_scale_factor: number | null;
  readonly refresh_hz_estimate: number | null;
  readonly devtools_open: boolean | null;
  readonly decode_backend: null;
  readonly parallel_decoder_available: null;
  readonly capabilities: {
    readonly webgpu: boolean;
    readonly wasm: boolean;
    readonly shared_array_buffer: boolean;
    readonly hardware_concurrency: number;
    readonly device_memory_gb: number | null;
  };
  readonly power_state: "unknown";
  readonly load_state: "unknown";
  readonly occlusion_state: "unknown";
}

export async function captureBuildIdentity(repositoryRoot?: string): Promise<BuildIdentity> {
  return capture(repositoryRoot);
}

export async function readEnvironmentIdentity(
  launched: LaunchedApp,
): Promise<EnvironmentIdentity> {
  const [main, renderer] = await Promise.all([
    launched.app.evaluate(async ({ app, BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const display = window
        ? screen.getDisplayMatching(window.getBounds())
        : screen.getPrimaryDisplay();

      let rawGpuInfo: unknown = null;
      try {
        rawGpuInfo = await app.getGPUInfo("basic");
      } catch {
        // Electron rejects this capability when GPU information is unavailable.
      }

      const gpuInfo =
        typeof rawGpuInfo === "object" && rawGpuInfo !== null
          ? (rawGpuInfo as Record<string, unknown>)
          : null;
      const rawDevices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : [];
      const devices = rawDevices.flatMap((value) => {
        if (typeof value !== "object" || value === null) return [];
        const device = value as Record<string, unknown>;
        return [
          {
            vendor_id: typeof device.vendorId === "number" ? device.vendorId : null,
            device_id: typeof device.deviceId === "number" ? device.deviceId : null,
            name: typeof device.deviceString === "string" ? device.deviceString : null,
            active: typeof device.active === "boolean" ? device.active : null,
          },
        ];
      });

      const allFeatureStatus = app.getGPUFeatureStatus() as unknown as Record<string, unknown>;
      const featureNames = [
        "gpu_compositing",
        "rasterization",
        "webgl",
        "webgl2",
        "webgpu",
        "video_decode",
        "video_encode",
      ];
      const featureStatus = Object.fromEntries(
        featureNames.map((name) => [
          name,
          typeof allFeatureStatus[name] === "string" ? allFeatureStatus[name] : null,
        ]),
      );
      const contentSize = window?.getContentSize();
      const refresh = display.displayFrequency;

      return {
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
        os: {
          platform: process.platform,
          release: process.getSystemVersion(),
          arch: process.arch,
        },
        gpu: {
          info_status: gpuInfo ? ("available" as const) : ("unavailable" as const),
          devices,
          feature_status: featureStatus,
        },
        visible: window ? window.isVisible() : null,
        focused: window ? window.isFocused() : null,
        window_content_dip_px: contentSize
          ? { width: contentSize[0], height: contentSize[1] }
          : null,
        device_scale_factor:
          Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
            ? display.scaleFactor
            : null,
        refresh_hz_estimate:
          Number.isFinite(refresh) && refresh > 0 ? refresh : null,
        devtools_open: window ? window.webContents.isDevToolsOpened() : null,
      };
    }),
    launched.page.evaluate(() => {
      const chromeVersion = /\bChrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null;
      const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      return {
        chrome: chromeVersion,
        window_css_px: { width: window.innerWidth, height: window.innerHeight },
        capabilities: {
          webgpu: "gpu" in navigator,
          wasm: typeof WebAssembly === "object",
          shared_array_buffer: typeof SharedArrayBuffer === "function",
          hardware_concurrency: navigator.hardwareConcurrency,
          device_memory_gb:
            typeof deviceMemory === "number" && Number.isFinite(deviceMemory)
              ? deviceMemory
              : null,
        },
      };
    }),
  ]);

  const cpus = os.cpus();
  const logicalCores = os.availableParallelism?.() ?? cpus.length;
  return {
    electron: main.electron,
    chrome: renderer.chrome ?? main.chrome,
    os: main.os,
    runner_class: process.env.CI ? "ci" : "local",
    cpu: {
      model: cpus[0]?.model.trim() || "unknown",
      logical_cores: logicalCores,
    },
    memory: {
      total_bytes: os.totalmem(),
      free_bytes: os.freemem(),
    },
    gpu: main.gpu,
    visible: main.visible,
    focused: main.focused,
    window_css_px: renderer.window_css_px,
    window_content_dip_px: main.window_content_dip_px,
    device_scale_factor: main.device_scale_factor,
    refresh_hz_estimate: main.refresh_hz_estimate,
    devtools_open: main.devtools_open,
    decode_backend: null,
    parallel_decoder_available: null,
    capabilities: renderer.capabilities,
    power_state: "unknown",
    load_state: "unknown",
    occlusion_state: "unknown",
  };
}
